export function validateDispatchLease({provided,expected,actualSessionId}={}){
  if(!provided||!expected||provided.sessionId!==expected.sessionId||provided.generation!==expected.generation||actualSessionId!==provided.sessionId){
    throw Object.assign(new Error('production owner/session lease changed'),{status:409,code:'PRODUCTION_LEASE_CHANGED'});
  }
  return expected;
}
