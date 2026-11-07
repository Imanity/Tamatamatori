// Compatibility entry point; no per-model converter code.
import {run} from './landmarks.mjs';
const [id,input]=process.argv.slice(2);if(!id||!input)throw Error('用法：node scripts/build-landmark-models.mjs <id> <GLB>');
const result=await run(['batch','--ids',id,'--input',input]);if(!result.ok)process.exitCode=1;
