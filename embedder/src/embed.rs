//! Mirrors transformers.js `pipeline('feature-extraction')([text], { pooling: 'mean', normalize: true })`
//! so vectors stay comparable with ones already stored.
//!
//! Each text runs unpadded, one per session run. The q8 model quantizes
//! activations with one dynamic scale per tensor, padded positions included,
//! so a padded batch makes a text's vector depend on its batch neighbours
//! (transformers.js batched vs alone: cosine as low as 0.967).

use std::path::Path;

use ort::session::{builder::GraphOptimizationLevel, Session, SessionInputValue};
use ort::value::Tensor;
use tokenizers::Tokenizer;

pub const DIM: usize = 384;
/// bge-small `model_max_length`.
const MAX_TOKENS: usize = 512;

pub struct Embedder {
    tokenizer: Tokenizer,
    session: Session,
    wants_token_type_ids: bool,
    pad_id: i64,
}

type BoxErr = Box<dyn std::error::Error + Send + Sync>;

impl Embedder {
    /// `model_dir` is the HF repo dir in the transformers.js cache.
    pub fn load(model_dir: &Path) -> Result<Self, BoxErr> {
        let mut tokenizer = Tokenizer::from_file(model_dir.join("tokenizer.json"))?;
        tokenizer.with_truncation(None)?;
        tokenizer.with_padding(None);
        let pad_id = tokenizer.token_to_id("[PAD]").unwrap_or(0) as i64;

        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).min(4);
        let session = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| e.to_string())?
            .with_intra_threads(threads)
            .map_err(|e| e.to_string())?
            .commit_from_file(model_dir.join("onnx").join("model_quantized.onnx"))?;
        let wants_token_type_ids = session.inputs.iter().any(|i| i.name == "token_type_ids");
        Ok(Self { tokenizer, session, wants_token_type_ids, pad_id })
    }

    pub fn embed(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>, BoxErr> {
        let mut out = Vec::with_capacity(texts.len());
        for t in texts {
            out.extend(self.run_batch(std::slice::from_ref(t))?);
        }
        Ok(out)
    }

    fn run_batch(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>, BoxErr> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let encodings = self.tokenizer.encode_batch(texts.to_vec(), true)?;
        // transformers.js truncates after adding special tokens, so a long
        // text loses its trailing [SEP]; do the same for parity.
        let ids: Vec<Vec<i64>> = encodings
            .iter()
            .map(|e| e.get_ids().iter().take(MAX_TOKENS).map(|&t| t as i64).collect())
            .collect();
        let batch = ids.len();
        let seq = ids.iter().map(Vec::len).max().unwrap_or(0).max(1);

        let mut input_ids = vec![self.pad_id; batch * seq];
        let mut mask = vec![0i64; batch * seq];
        for (b, row) in ids.iter().enumerate() {
            for (j, &t) in row.iter().enumerate() {
                input_ids[b * seq + j] = t;
                mask[b * seq + j] = 1;
            }
        }

        let shape = [batch as i64, seq as i64];
        let mut inputs: Vec<(&str, SessionInputValue)> = vec![
            ("input_ids", Tensor::from_array((shape, input_ids))?.into()),
            ("attention_mask", Tensor::from_array((shape, mask.clone()))?.into()),
        ];
        if self.wants_token_type_ids {
            inputs.push(("token_type_ids", Tensor::from_array((shape, vec![0i64; batch * seq]))?.into()));
        }
        let outputs = self.session.run(inputs)?;
        let (out_shape, hidden) = outputs[0].try_extract_tensor::<f32>()?;
        let expected = [batch as i64, seq as i64, DIM as i64];
        if out_shape.as_ref() != expected.as_slice() {
            return Err(format!("model output shape {:?}, expected {expected:?}", out_shape.as_ref()).into());
        }
        Ok(pool_and_normalize(hidden, &mask, batch, seq, DIM))
    }
}

/// Attention-masked mean over tokens, then L2 normalization.
pub fn pool_and_normalize(hidden: &[f32], mask: &[i64], batch: usize, seq: usize, dim: usize) -> Vec<Vec<f32>> {
    (0..batch)
        .map(|b| {
            let mut v = vec![0f32; dim];
            let mut count = 0f32;
            for j in 0..seq {
                let m = mask[b * seq + j] as f32;
                if m == 0.0 {
                    continue;
                }
                count += m;
                let row = &hidden[(b * seq + j) * dim..(b * seq + j + 1) * dim];
                for k in 0..dim {
                    v[k] += row[k] * m;
                }
            }
            if count > 0.0 {
                v.iter_mut().for_each(|x| *x /= count);
            }
            let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm > 0.0 {
                v.iter_mut().for_each(|x| *x /= norm);
            }
            v
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masked_mean_then_l2() {
        // batch 2, seq 3, dim 2; row 1's last token is padding.
        let hidden = [1.0, 0.0, 3.0, 0.0, 9.0, 9.0, 0.0, 2.0, 0.0, 4.0, 100.0, 100.0];
        let mask = [1, 1, 1, 1, 1, 0];
        let out = pool_and_normalize(&hidden, &mask, 2, 3, 2);
        // row 0 mean = (13/3, 3) → normalized
        let (x, y) = (13.0f32 / 3.0, 3.0f32);
        let n = (x * x + y * y).sqrt();
        assert!((out[0][0] - x / n).abs() < 1e-6 && (out[0][1] - y / n).abs() < 1e-6);
        // row 1 ignores the padded (100, 100) token: mean (0, 3) → (0, 1)
        assert_eq!(out[1], vec![0.0, 1.0]);
    }

    #[test]
    fn all_masked_row_is_zero_not_nan() {
        let out = pool_and_normalize(&[5.0, 5.0], &[0], 1, 1, 2);
        assert_eq!(out[0], vec![0.0, 0.0]);
    }
}
