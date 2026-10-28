// Non specification §9 / tutorial 13/18. Source text is internal data only.
import {DRIVE_KEYS} from './drive.mjs';
export const THOUGHT_STAGES = Object.freeze(['flit', 'fixation']);

// Initial .50 and tick multipliers/feedback: Non author follow-up (Phase 4).
// Boost, promotion age, post-feedback relief, and pool limits remain QIUQIU CHOICES.
export const QIUQIU_THOUGHT_CONFIG = Object.freeze({
  initialStrength:.50,
  repeatedExperienceBoost:.15,
  promotionAgeTicks:3,
  postFeedbackStrength:.70,
  flitRemovalStrength:.05,
  maxFlits:8,
  maxFixations:3
});

export function createThought({text, dimension, stage, strength, bornAt, fedCount, source}) {
  if (typeof text !== 'string' || !text.trim() || !DRIVE_KEYS.includes(dimension) ||
      !THOUGHT_STAGES.includes(stage) || !Number.isFinite(strength) || strength < 0 || strength > 1 ||
      !Number.isFinite(bornAt) || !Number.isInteger(fedCount) || fedCount < 0 ||
      typeof source !== 'string' || !source.trim()) throw new TypeError('explicit thought data required');
  return {text, dimension, stage, strength, bornAt, fedCount, source};
}

export function decayFlit(strength) {
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new RangeError('invalid flit strength');
  return strength * .82; // Non §9: per discrete tick.
}

export function reachedKnownPromotionThreshold(strength) {
  if (!Number.isFinite(strength) || strength < 0) throw new RangeError('invalid flit strength');
  return strength > .80; // Additional age/repeat condition is unpublished.
}

export function promoteFlit() {
  throw new Error('NON_FULL_PROMOTION_CONDITION_UNAVAILABLE');
}

export function tickFixation(strength, fedCount) {
  if (!Number.isFinite(strength) || strength < 0 || strength > 1 ||
      !Number.isInteger(fedCount) || fedCount < 0 || fedCount >= 3) throw new RangeError('invalid fixation state');
  const strengthAfterGrowth = strength * 1.10; // Non §9; no unpublished clamp.
  if (strengthAfterGrowth <= .85) return {strengthAfterGrowth, fedCount, driveDelta: 0, exits: false};
  const nextFedCount = fedCount + 1;
  return {
    strengthAfterGrowth, fedCount: nextFedCount, driveDelta: .18,
    exits: nextFedCount >= 3,
    continuationUnavailable: nextFedCount < 3 // Post-feedback relief is unknown.
  };
}

export function clearLibidoFixationsOnRelease(thoughts) {
  if (!Array.isArray(thoughts)) throw new TypeError('thoughts must be an array');
  return thoughts.filter(thought => !(thought.dimension === 'libido' && thought.stage === 'fixation'));
}

// Numeric data may feed Drive. No thought text is returned to a prompt path.
export function thoughtDriveData(thoughts) {
  if (!Array.isArray(thoughts)) throw new TypeError('thoughts must be an array');
  return thoughts.map(({dimension, stage, strength, fedCount}) => ({dimension, stage, strength, fedCount}));
}

const thoughtIdentity = text => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

function enforcePoolCaps(thoughts, config) {
  const kept = [...thoughts];
  for (const [stage, cap] of [['flit',config.maxFlits],['fixation',config.maxFixations]]) {
    while (kept.filter(item => item.stage === stage).length > cap) {
      // QIUQIU IMPLEMENTATION CHOICE: evict weakest, then oldest, then ID.
      const victim = kept.filter(item => item.stage === stage)
        .sort((a,b) => a.strength - b.strength || a.bornAt - b.bornAt || String(a.id).localeCompare(String(b.id)))[0];
      kept.splice(kept.indexOf(victim),1);
    }
  }
  return kept;
}

export function addExperienceThought(thoughts, {text, dimension, source, at, id}, config = QIUQIU_THOUGHT_CONFIG) {
  if (!Array.isArray(thoughts) || !Number.isFinite(at) || typeof id !== 'string' || !id) throw new TypeError('experience input required');
  const base = createThought({text, dimension, source, stage:'flit', strength:config.initialStrength, bornAt:at, fedCount:0});
  const next = thoughts.map(item => ({...item}));
  const duplicate = next.find(item => item.dimension === dimension && thoughtIdentity(item.text) === thoughtIdentity(text));
  if (duplicate) {
    duplicate.strength = Math.min(1, duplicate.strength + config.repeatedExperienceBoost);
    duplicate.updatedAt = at;
  } else next.push({...base, id, ageTicks:0, updatedAt:at});
  return enforcePoolCaps(next, config);
}

export function evolveThoughtsOneTick(thoughts, at, config = QIUQIU_THOUGHT_CONFIG) {
  if (!Array.isArray(thoughts) || !Number.isFinite(at)) throw new TypeError('thought tick input required');
  const next = [], feedback = Object.create(null);
  for (const thought of thoughts) {
    const ageTicks = (thought.ageTicks ?? 0) + 1;
    if (thought.stage === 'flit') {
      // QIUQIU CHOICE: age and >.80 are checked before this tick's ×.82 decay.
      if (ageTicks >= config.promotionAgeTicks && reachedKnownPromotionThreshold(thought.strength)) {
        next.push({...thought, stage:'fixation', ageTicks, updatedAt:at});
      } else {
        const strength = decayFlit(thought.strength); // NON DIRECT ×.82.
        if (strength > config.flitRemovalStrength) next.push({...thought, strength, ageTicks, updatedAt:at});
      }
    } else if (thought.stage === 'fixation') {
      const result = tickFixation(thought.strength, thought.fedCount); // NON DIRECT ×1.10, >.85, +.18, third exit.
      if (result.driveDelta) feedback[thought.dimension] = (feedback[thought.dimension] ?? 0) + result.driveDelta;
      if (!result.exits) next.push({...thought,
        strength: result.driveDelta ? config.postFeedbackStrength : Math.min(1,result.strengthAfterGrowth),
        fedCount:result.fedCount, ageTicks, updatedAt:at});
    } else throw new TypeError('unknown thought stage');
  }
  return {thoughts:enforcePoolCaps(next,config), feedback};
}
