// Compatibility entry point; all conversion is driven by the shared recipe pipeline.
import {run} from './landmarks.mjs';
const input=process.argv[2];if(!input)throw Error('用法：node scripts/build-skytree.mjs <GLB>');
const result=await run(['batch','--ids=tokyo-skytree','--input',input]);if(!result.ok)process.exitCode=1;
