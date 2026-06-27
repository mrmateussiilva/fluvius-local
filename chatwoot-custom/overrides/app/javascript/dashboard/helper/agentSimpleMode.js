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
