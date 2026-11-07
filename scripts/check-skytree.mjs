// Historical compatibility command; shared batch computes full-width coverage.
import {run} from './landmarks.mjs';
const result=await run(['check','--ids=tokyo-skytree']);if(!result.ok)process.exitCode=1;
