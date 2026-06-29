const truthyValues = ['1', 'true', 'yes', 'on'];
const falsyValues = ['0', 'false', 'no', 'off'];

const normalizedFlag = value =>
  String(value || '')
    .trim()
    .toLowerCase();

const envSimpleMode = () =>
  normalizedFlag(import.meta.env.VITE_FLUVIUS_AGENT_SIMPLE_MODE || 'auto');

const localStorageSimpleMode = () => {
  try {
    return normalizedFlag(
      window.localStorage?.getItem('fluviusAgentSimpleMode')
    );
  } catch {
    return '';
  }
};

const accountRole = (user, accountId, currentRole = '') => {
  const roleFromGetter = normalizedFlag(currentRole);
  if (roleFromGetter) return roleFromGetter;

  const accounts = Array.isArray(user?.accounts) ? user.accounts : [];
  const account = accounts.find(item => Number(item.id) === Number(accountId));
  return normalizedFlag(account?.role || user?.role || '');
};

const accountPermissions = (user, accountId) => {
  const accounts = Array.isArray(user?.accounts) ? user.accounts : [];
  const account = accounts.find(item => Number(item.id) === Number(accountId));
  return account?.permissions || user?.permissions || [];
};

const hasFullDashboardAccess = (user, accountId, currentRole = '') => {
  const role = accountRole(user, accountId, currentRole);
  const permissions = accountPermissions(user, accountId);
  return (
    ['administrator', 'supervisor'].includes(role) ||
    permissions.includes('administrator')
  );
};

export const isAgentSimpleMode = (user, accountId, currentRole = '') => {
  if (hasFullDashboardAccess(user, accountId, currentRole)) return false;

  const localFlag = localStorageSimpleMode();
  if (truthyValues.includes(localFlag)) return true;
  if (falsyValues.includes(localFlag)) return false;

  const envFlag = envSimpleMode();
  if (truthyValues.includes(envFlag)) return true;
  if (falsyValues.includes(envFlag)) return false;

  return accountRole(user, accountId, currentRole) === 'agent';
};

export const isSimplifiedAgentMode = isAgentSimpleMode;
export const isAgentMessengerMode = isAgentSimpleMode;
export const shouldUseAgentMessengerMode = isAgentSimpleMode;
export const shouldUseAgentMessengerLayout = isAgentSimpleMode;

export const cappedCount = count => {
  const numericCount = Number(count || 0);
  return numericCount > 99 ? '99+' : String(numericCount);
};

export const isLikelyPhoneSearch = value => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 8;
};

export const conversationSearchText = conversation => {
  const sender = conversation?.meta?.sender || {};
  const emailSubject =
    conversation?.custom_attributes?.email?.subject ||
    conversation?.customAttributes?.email?.subject ||
    '';

  return [
    sender.name,
    sender.phone_number,
    sender.identifier,
    sender.email,
    conversation?.display_id,
    conversation?.id,
    conversation?.identifier,
    conversation?.meta?.sender?.additional_attributes?.source_id,
    conversation?.contact_inbox?.source_id,
    conversation?.last_non_activity_message?.content,
    conversation?.lastNonActivityMessage?.content,
    emailSubject,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
};

export const isWhatsAppGroupConversation = conversation => {
  const sender = conversation?.meta?.sender || {};
  const identifiers = [
    sender.identifier,
    sender.additional_attributes?.source_id,
    sender.additionalAttributes?.sourceId,
    conversation?.identifier,
    conversation?.contact_inbox?.source_id,
    conversation?.contactInbox?.sourceId,
    conversation?.additional_attributes?.source_id,
    conversation?.additionalAttributes?.sourceId,
  ];

  return identifiers.some(value => String(value || '').includes('@g.us'));
};
