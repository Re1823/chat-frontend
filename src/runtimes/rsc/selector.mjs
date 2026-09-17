import {authoritativeConversationalTurns,classifyTranscriptRecord,authoritativeTurnEndpoint} from './authoritative-turns.mjs';
import {isCompactRecord} from './transcript-parser.mjs';
export const RSC_TARGET_TOKENS=30000,RECENT_TAIL_TURNS=12;
const estimate=text=>Math.ceil(Buffer.byteLength(text,'utf8')/3);
export const classify=classifyTranscriptRecord;
export function conversationalTurns(records){return authoritativeConversationalTurns(records).turns}
export function currentSafeSegment(records){
 const result=authoritativeConversationalTurns(records),boundaryIndex=records.reduce((latest,record,index)=>isCompactRecord(record)?index:latest,-1),turns=result.turns.filter(turn=>turn.sourceIndex>boundaryIndex);
 return {turns,boundaryIndex,boundary:boundaryIndex>=0?records[boundaryIndex]:null,activeLeaf:result.activeLeaf,branchValid:result.branchValid};
}
export function validateRecentTail(records,tail,{limit=RECENT_TAIL_TURNS}={}){
 const safe=currentSafeSegment(records),expected=safe.turns.slice(-limit),endpoint=authoritativeTurnEndpoint(records).identity;
 if(!safe.branchValid)return {valid:false,reason:'INVALID_ACTIVE_ANCESTRY',...safe};
 if(expected.length===0)return {valid:false,reason:'EMPTY_SAFE_SEGMENT',...safe};
 if(!Array.isArray(tail)||tail.length!==expected.length)return {valid:false,reason:'RECENT_TAIL_CARDINALITY',...safe};
 if(new Set(tail.map(turn=>turn.id)).size!==tail.length)return {valid:false,reason:'DUPLICATE_RECENT_TURN',...safe};
 if(tail.some((turn,index)=>turn?.id!==expected[index]?.id))return {valid:false,reason:'RECENT_TAIL_ORDER_OR_MEMBERSHIP',...safe};
 if(tail.at(-1)?.id!==endpoint?.turnId)return {valid:false,reason:'RECENT_TAIL_ENDPOINT_MISMATCH',...safe};
 return {valid:true,reason:null,selectedCount:tail.length,eligibleAvailable:safe.turns.length,endpoint,...safe};
}
export function selectCarryover(records,{targetTokens=RSC_TARGET_TOKENS,tailTurns=RECENT_TAIL_TURNS}={}){
 const counts={droppedNoise:0,droppedToolOnly:0,droppedInjection:0,droppedSensitive:0,droppedIncomplete:0};let poisonScore=0;
 for(const record of records){const {kind}=classify(record);if(kind==='poison')poisonScore++;else if(kind==='noise'||kind==='compact')counts.droppedNoise++;else if(kind==='tool')counts.droppedToolOnly++;else if(kind==='injection')counts.droppedInjection++;else if(kind==='sensitive')counts.droppedSensitive++}
 const safe=currentSafeSegment(records),turns=safe.turns,tail=turns.slice(-tailTurns),tailSet=new Set(tail),older=turns.slice(0,-tail.length),ranked=[...older.filter(t=>t.kinds.has('state')),...older.filter(t=>t.kinds.has('high')&&!t.kinds.has('state'))];let selected=[...tail],tokens=selected.reduce((n,t)=>n+estimate(t.text),0);
 for(const turn of ranked){if(tailSet.has(turn))continue;const cost=estimate(turn.text);if(tokens+cost<=targetTokens){selected.push(turn);tokens+=cost}}
 selected.sort((a,b)=>a.sourceIndex-b.sourceIndex);while(tokens>targetTokens&&selected.length>tail.length){const old=selected.shift();tokens-=estimate(old.text)}
 const recentTailValidation=validateRecentTail(records,tail,{limit:tailTurns});
 return {selected,estimatedTokens:tokens,estimated:true,targetTokens,selectedTailTurns:tail.filter(t=>selected.includes(t)).length,eligibleAvailableInCurrentSafeSegment:turns.length,recentTailValid:recentTailValidation.valid,recentTailFailure:recentTailValidation.reason,selectedHighSignal:selected.filter(t=>t.kinds.has('high')).length,selectedState:selected.filter(t=>t.kinds.has('state')).length,cleanCandidateCount:turns.length,poisonScore,poisonDetected:poisonScore>0,...counts};
}
