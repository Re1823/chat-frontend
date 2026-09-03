export const turnEvent = {
  started: turnId => ({type:'turn_started', turnId, runtime:'api'}),
  delta: (turnId, delta) => ({type:'segment_delta', turnId, delta}),
  segmentDone: turnId => ({type:'segment_done', turnId}),
  stopped: turnId => ({type:'turn_stopped', turnId}),
  error: (turnId, error) => ({type:'turn_error', turnId, error}),
  done: turnId => ({type:'turn_done', turnId})
};

export function writeTurnEvent(response, format, event) {
  if (format === 'ndjson') {
    response.write(`${JSON.stringify(event)}\n`);
    return;
  }
  if (event.type === 'segment_delta') response.write(`data: ${JSON.stringify({delta:event.delta})}\n\n`);
  if (event.type === 'turn_done') response.write('data: {"done":true}\n\n');
}
