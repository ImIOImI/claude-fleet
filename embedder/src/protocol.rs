//! Frames: u32 little-endian byte length, then that many bytes of UTF-8 JSON.

use std::io::{self, Read, Write};

pub const MAX_FRAME: usize = 64 * 1024 * 1024;

/// `Ok(None)` on a clean EOF before a frame starts.
pub fn read_frame<R: Read>(r: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        let n = r.read(&mut len[got..])?;
        if n == 0 {
            if got == 0 {
                return Ok(None);
            }
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "truncated frame header"));
        }
        got += n;
    }
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("frame of {len} bytes exceeds {MAX_FRAME}")));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

pub fn write_frame<W: Write>(w: &mut W, payload: &[u8]) -> io::Result<()> {
    w.write_all(&(payload.len() as u32).to_le_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trip() {
        let mut out = Vec::new();
        write_frame(&mut out, b"{\"a\":1}").unwrap();
        write_frame(&mut out, b"").unwrap();
        let mut r = Cursor::new(out);
        assert_eq!(read_frame(&mut r).unwrap().unwrap(), b"{\"a\":1}");
        assert_eq!(read_frame(&mut r).unwrap().unwrap(), b"");
        assert!(read_frame(&mut r).unwrap().is_none());
    }

    #[test]
    fn oversized_is_rejected() {
        let mut r = Cursor::new(((MAX_FRAME + 1) as u32).to_le_bytes().to_vec());
        assert_eq!(read_frame(&mut r).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn truncated_body_errors() {
        let mut bytes = 10u32.to_le_bytes().to_vec();
        bytes.extend_from_slice(b"abc");
        assert!(read_frame(&mut Cursor::new(bytes)).is_err());
    }

    #[test]
    fn truncated_header_errors() {
        assert!(read_frame(&mut Cursor::new(vec![1u8, 0])).is_err());
    }
}
