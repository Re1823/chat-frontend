import {DRIVE_KEYS} from './drive.mjs';

// QIUQIU ADAPTER, not a claim about Non's original tag syntax. Tool delivery
// supplies a complete message; no prefix or partial tag is ever streamed.
const OPEN = '<念';
const CLOSE = '</念>';
const MAX_THOUGHT_CODEPOINTS = 120; // QIUQIU IMPLEMENTATION CHOICE.
const TAG = /^<念 drive="([a-z]+)">([^<>]+)<\/念>$/u;

export function parseThoughtTaggedMessage(text) {
  if (typeof text !== 'string') throw new TypeError('complete frontend text required');
  const start=text.indexOf(OPEN),closing=text.indexOf(CLOSE);
  if(start<0&&closing<0)return {visibleText:text,thought:null,tagged:false};
  // Exactly one complete tag is eligible. A malformed or second tag creates
  // no Thought; the presentation layer separately redacts it fail-open.
  if(start<0||closing<start)throw new Error('INVALID_THOUGHT_TAG');
  const end=closing+CLOSE.length;
  if(text.indexOf(OPEN,start+OPEN.length)>=0||text.indexOf(CLOSE,end)>=0)
    throw new Error('INVALID_THOUGHT_TAG');
  const hidden=text.slice(start,end);
  const suffix=text.slice(end);
  const visibleText=suffix.trim()?text.slice(0,start)+suffix:text.slice(0,start).trimEnd();
  const match=TAG.exec(hidden);
  if (!match || !visibleText.trim()) throw new Error('INVALID_THOUGHT_TAG');
  const [,dimension,rawText]=match;
  const thoughtText=rawText.trim();
  if (!DRIVE_KEYS.includes(dimension) || !thoughtText ||
      [...thoughtText].length > MAX_THOUGHT_CODEPOINTS ||
      /[\p{Cc}\p{Cf}]/u.test(thoughtText)) throw new Error('INVALID_THOUGHT_TAG');
  return {visibleText, thought:{dimension,text:thoughtText}, tagged:true};
}

// Consumer-facing transcript views must never reclassify tool input as an
// ordinary assistant utterance. This is deliberately lossy on malformed tags.
export function stripThoughtTagFromHistory(text) {
  if (typeof text !== 'string') return '';
  try { return parseThoughtTaggedMessage(text).visibleText; }
  catch {
    let remaining=text,visible='';
    while(remaining){
      const open=remaining.indexOf(OPEN),close=remaining.indexOf(CLOSE);
      if(open<0&&close<0)return visible+remaining;
      if(close>=0&&(open<0||close<open)){
        visible+=remaining.slice(0,close);
        remaining=remaining.slice(close+CLOSE.length);
        continue;
      }
      visible+=remaining.slice(0,open);
      if(close<0)return visible.trimEnd();
      remaining=remaining.slice(close+CLOSE.length);
    }
    return visible.trimEnd();
  }
}
