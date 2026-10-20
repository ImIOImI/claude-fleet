import * as esbuild from '/workspace/claude-fleet/node_modules/esbuild/lib/main.js';
const stub = { name:'stub', setup(b){
  b.onResolve({filter:/^@xterm\/|\.css$|\.woff2$/}, a=>({path:a.path, namespace:'stub'}));
  b.onLoad({filter:/.*/, namespace:'stub'}, ()=>({contents:'module.exports = new Proxy(function(){}, {get:(t,k)=>k==="__esModule"?true:t, construct(){return {}}});', loader:'js'}));
}};
await esbuild.build({ entryPoints:[process.argv[2]], bundle:true, platform:'node', format:'cjs', outfile:process.argv[3], jsx:'automatic', nodePaths:['/workspace/claude-fleet/node_modules'], plugins:[stub], define:{__BUILD_SHA__:'"dev"', 'import.meta.env.DEV':'false'}, logLevel:'error' });
