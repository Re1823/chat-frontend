import {authoritativeConversationalTurns,classifyTranscriptRecord} from './authoritative-turns.mjs';
export const RSC_TARGET_TOKENS=30000,RECENT_TAIL_TURNS=12;
const estimate=text=>Math.ceil(Buffer.byteLength(text,'utf8')/3);
export const classify=classifyTranscriptRecord;
export function conversationalTurns(records){return authoritativeConversationalTurns(records).turns}
export function selectCarryover(records,{targetTokens=RSC_TARGET_TOKENS,tailTurns=RECENT_TAIL_TURNS}={}){
 const counts={droppedNoise:0,droppedToolOnly:0,droppedInjection:0,droppedSensitive:0,droppedIncomplete:0};let poisonScore=0;
 for(const record of records){const {kind}=classify(record);if(kind==='poison')poisonScore++;else if(kind==='noise'||kind==='compact')counts.droppedNoise++;else if(kind==='tool')counts.droppedToolOnly++;else if(kind==='injection')counts.droppedInjection++;else if(kind==='sensitive')counts.droppedSensitive++}
 const turns=conversationalTurns(records),tail=turns.slice(-tailTurns),tailSet=new Set(tail),older=turns.slice(0,-tail.length),ranked=[...older.filter(t=>t.kinds.has('state')),...older.filter(t=>t.kinds.has('high')&&!t.kinds.has('state'))];let selected=[...tail],tokens=selected.reduce((n,t)=>n+estimate(t.text),0);
 for(const turn of ranked){if(tailSet.has(turn))continue;const cost=estimate(turn.text);if(tokens+cost<=targetTokens){selected.push(turn);tokens+=cost}}
 selected.sort((a,b)=>a.sourceIndex-b.sourceIndex);while(tokens>targetTokens&&selected.length>tail.length){const old=selected.shift();tokens-=estimate(old.text)}
 return {selected,estimatedTokens:tokens,estimated:true,targetTokens,selectedTailTurns:tail.filter(t=>selected.includes(t)).length,selectedHighSignal:selected.filter(t=>t.kinds.has('high')).length,selectedState:selected.filter(t=>t.kinds.has('state')).length,cleanCandidateCount:turns.length,poisonScore,poisonDetected:poisonScore>0,...counts};
}
