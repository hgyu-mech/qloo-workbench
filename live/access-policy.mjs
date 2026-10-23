// Deliberately fail closed. This is not a statement that access is free.
export const ACCESS_POLICY = Object.freeze({
  freeAccessConfirmed: false,
  enabled: false,
  evidenceReference: null,
  expiresAt: null,
  httpAttemptBudget: 0,
});

export const REVIEW_BASIS = 'event-entitlement-no-price-notice';
export const COST_CERTAINTY = 'inferred-not-provider-guarantee';
export const REVIEW_FACTS = Object.freeze({
  eventKeyIssued: 'QLOO_EVENT_KEY_ISSUED',
  userZeroSpendAuthorized: 'QLOO_USER_ZERO_SPEND_AUTHORIZED',
  noFeeNoticeInIssuance: 'QLOO_NO_FEE_NOTICE_IN_ISSUANCE',
  noPaymentFieldsInIssuanceForm: 'QLOO_NO_PAYMENT_FIELDS_IN_ISSUANCE_FORM',
  noPaidConversion: 'QLOO_NO_PAID_CONVERSION',
});

export function requireAccess(policy, now = Date.now()) {
  const reviewedEvent = policy?.accessBasis === REVIEW_BASIS;
  const reviewedAt = Date.parse(policy?.reviewedAt);
  const expiresAt = Date.parse(policy?.expiresAt);
  const accessValid = reviewedEvent
    ? policy.freeAccessConfirmed === false && policy.costCertainty === COST_CERTAINTY
      && Object.keys(REVIEW_FACTS).every(name => policy[name] === true)
      && /^[a-f0-9]{64}$/.test(policy.reviewRecordSha256 ?? '')
      && Number.isFinite(reviewedAt) && reviewedAt <= now && expiresAt > reviewedAt
      && expiresAt - reviewedAt <= 30 * 60 * 1000 && policy.httpAttemptBudget === 2
    : policy?.accessBasis === undefined && policy?.freeAccessConfirmed === true;
  // A reviewed event entitlement is explicitly an inference. Neither schema
  // controls provider billing; v1's stronger confirmation remains unchanged.
  if (policy?.enabled !== true || !accessValid
      || typeof policy.evidenceReference !== 'string' || !policy.evidenceReference
      || !Number.isFinite(expiresAt) || expiresAt <= now
      || !Number.isInteger(policy.httpAttemptBudget) || policy.httpAttemptBudget < 1 || policy.httpAttemptBudget > 4) {
    throw new Error('FREE_ACCESS_NOT_CONFIRMED');
  }
}
