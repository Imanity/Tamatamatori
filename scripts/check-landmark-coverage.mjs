// Six-direction coverage is computed by batch and pinned by check.
import {run} from './landmarks.mjs';
const id=process.argv[2];if(!id)throw Error('用法：node scripts/check-landmark-coverage.mjs <id>');
const result=await run(['check','--ids',id]);if(!result.ok)process.exitCode=1;
