import { isAgentSimpleMode } from '../agentSimpleMode';

describe('#isAgentSimpleMode', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('enables simple mode for regular agents in the current account', () => {
    const user = { accounts: [{ id: 1, role: 'agent', permissions: [] }] };

    expect(isAgentSimpleMode(user, 1)).toBe(true);
  });

  it('keeps the full dashboard for administrators and supervisors', () => {
    const administrator = {
      accounts: [{ id: 1, role: 'administrator', permissions: [] }],
    };
    const supervisor = {
      accounts: [{ id: 1, role: 'supervisor', permissions: [] }],
    };
    const customAdmin = {
      accounts: [
        { id: 1, role: 'custom_role', permissions: ['administrator'] },
      ],
    };

    window.localStorage.setItem('fluviusAgentSimpleMode', 'true');

    expect(isAgentSimpleMode(administrator, 1)).toBe(false);
    expect(isAgentSimpleMode(supervisor, 1)).toBe(false);
    expect(isAgentSimpleMode(customAdmin, 1)).toBe(false);
  });

  it('allows local override for non administrative users', () => {
    const user = {
      accounts: [{ id: 1, role: 'custom_role', permissions: [] }],
    };

    window.localStorage.setItem('fluviusAgentSimpleMode', 'true');
    expect(isAgentSimpleMode(user, 1)).toBe(true);

    window.localStorage.setItem('fluviusAgentSimpleMode', 'false');
    expect(isAgentSimpleMode(user, 1)).toBe(false);
  });

  it('uses the current role getter when the account payload is not enough', () => {
    const user = { accounts: [] };

    expect(isAgentSimpleMode(user, 1, 'agent')).toBe(true);
    expect(isAgentSimpleMode(user, 1, 'administrator')).toBe(false);
    expect(isAgentSimpleMode(user, 1, 'supervisor')).toBe(false);
  });
});
