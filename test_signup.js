

async function testSignup(payload) {
  try {
    const res = await fetch('http://localhost:3000/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `test${Date.now()}@test.com`,
        password: 'Password123!',
        confirm_success_url: 'http://localhost:3000',
        ...payload
      })
    });
    const data = await res.json();
    if (res.status < 300 || (data.status === 'success')) {
      console.log('SUCCESS with payload keys:', Object.keys(payload));
      return true;
    } else {
      console.log('FAILED with', Object.keys(payload), data.errors);
      return false;
    }
  } catch(e) {
    console.log('Error', e.message);
    return false;
  }
}

async function run() {
  await testSignup({ name: 'Admin', account_name: 'Empresa' });
  await testSignup({ user_full_name: 'Admin', account_name: 'Empresa' });
  await testSignup({ full_name: 'Admin', account_name: 'Empresa' });
  await testSignup({ account_name: 'Empresa', user: { name: 'Admin' } });
  await testSignup({ account_name: 'Empresa', user: { full_name: 'Admin' } });
}
run();
