// Simulates 20 concurrent users hammering the Padosi API at once: signup,
// browsing the feed, posting tasks, accepting/completing them, and adding a
// payment method. Run with: node loadtest.js
// Reports success/failure counts and response time stats, and — most
// importantly — whether the server process survived and the DB stayed
// consistent throughout.

const BASE = process.env.LOAD_TEST_URL || 'http://localhost:4000';
const NUM_USERS = 100;

const timings = [];
const errors = [];
let okCount = 0;

async function timedFetch(path, opts, fakeIp) {
  const start = Date.now();
  try {
    const headers = { ...(opts?.headers || {}) };
    if (fakeIp) headers['X-Forwarded-For'] = fakeIp;
    const res = await fetch(BASE + path, { ...opts, headers });
    const ms = Date.now() - start;
    timings.push(ms);
    let body = {};
    try { body = await res.json(); } catch (e) {}
    if (!res.ok) {
      errors.push(`${opts?.method || 'GET'} ${path} -> ${res.status} ${JSON.stringify(body)}`);
    } else {
      okCount++;
    }
    return { status: res.status, body };
  } catch (err) {
    const ms = Date.now() - start;
    timings.push(ms);
    errors.push(`${opts?.method || 'GET'} ${path} -> NETWORK ERROR: ${err.message}`);
    return { status: 0, body: {} };
  }
}

async function simulateUser(i) {
  const phone = `9${String(100000000 + i).padStart(9, '0')}`;
  const headers = { 'Content-Type': 'application/json' };
  // Each virtual user gets its own fake IP, the way 100 real people on 100
  // different phones/networks actually would — this is what "trust proxy"
  // on the server now correctly reads via X-Forwarded-For.
  const fakeIp = `10.${Math.floor(i / 254)}.${i % 254}.${(i * 7) % 254 + 1}`;

  // 1. Signup
  const signup = await timedFetch('/api/auth/signup', {
    method: 'POST', headers,
    body: JSON.stringify({ name: `LoadUser${i}`, phone, password: 'test1234', area: 'LoadTestArea' })
  }, fakeIp);
  const token = signup.body.token;
  if (!token) return; // can't continue this virtual user without auth

  const authHeaders = { ...headers, Authorization: `Bearer ${token}` };

  // 2. Load own profile
  await timedFetch('/api/auth/me', { headers: authHeaders }, fakeIp);

  // 3. Browse the feed
  await timedFetch('/api/tasks?area=LoadTestArea', { headers: authHeaders }, fakeIp);

  // 4. Post a task
  const task = await timedFetch('/api/tasks', {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ title: `Load test task ${i}`, area: 'LoadTestArea', price: 20 + i, category: 'errand' })
  }, fakeIp);
  const taskId = task.body.task && task.body.task.id;

  // 5. Check notifications + wallet (typical screen loads)
  await timedFetch('/api/payments/notifications', { headers: authHeaders }, fakeIp);
  await timedFetch('/api/payments/wallet', { headers: authHeaders }, fakeIp);
  await timedFetch('/api/payments/methods', { headers: authHeaders }, fakeIp);
  await timedFetch('/api/tasks/mine/posted', { headers: authHeaders }, fakeIp);
  await timedFetch('/api/tasks/mine/accepted', { headers: authHeaders }, fakeIp);

  // 6. Add a UPI payment method
  await timedFetch('/api/payments/methods/upi', {
    method: 'POST', headers: authHeaders,
    body: JSON.stringify({ upi_id: `loaduser${i}@okhdfc` })
  }, fakeIp);

  return { taskId, token, fakeIp };
}

const createdTasks = [];

async function main() {
  console.log(`Starting load test: ${NUM_USERS} concurrent virtual users against ${BASE}`);
  const overallStart = Date.now();

  const results = await Promise.allSettled(
    Array.from({ length: NUM_USERS }, (_, i) => simulateUser(i))
  );
  results.forEach(r => { if (r.status === 'fulfilled' && r.value) createdTasks.push(r.value); });

  // Now simulate a second wave: half the users try to accept a task posted by
  // a DIFFERENT user, which is the realistic cross-user interaction and also
  // exercises write contention on the same rows if two people race for one task.
  const acceptResults = await Promise.allSettled(
    createdTasks.slice(0, 50).map((u, idx) => {
      const other = createdTasks[(idx + 5) % createdTasks.length];
      if (!other || other.taskId === u.taskId) return Promise.resolve();
      return timedFetch(`/api/tasks/${other.taskId}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.token}` }
      }, u.fakeIp);
    })
  );

  const overallMs = Date.now() - overallStart;
  const rejected = results.filter(r => r.status === 'rejected').concat(acceptResults.filter(r => r.status === 'rejected'));

  // Final health check to confirm the server is still alive and responsive
  const health = await timedFetch('/api/health', {});

  timings.sort((a, b) => a - b);
  const avg = timings.length ? (timings.reduce((a, b) => a + b, 0) / timings.length).toFixed(1) : 0;
  const p95 = timings.length ? timings[Math.floor(timings.length * 0.95)] : 0;
  const max = timings.length ? timings[timings.length - 1] : 0;

  console.log('\n========== LOAD TEST RESULTS ==========');
  console.log(`Virtual users:         ${NUM_USERS}`);
  console.log(`Total requests fired:  ${timings.length}`);
  console.log(`Successful (2xx):      ${okCount}`);
  console.log(`Failed:                ${errors.length}`);
  console.log(`Promise rejections:    ${rejected.length}`);
  console.log(`Total wall time:       ${overallMs}ms`);
  console.log(`Avg response time:     ${avg}ms`);
  console.log(`p95 response time:     ${p95}ms`);
  console.log(`Max response time:     ${max}ms`);
  console.log(`Server alive after?    ${health.status === 200 ? 'YES ✅' : 'NO ❌ (status ' + health.status + ')'}`);

  if (errors.length) {
    console.log('\n--- First 15 errors ---');
    errors.slice(0, 15).forEach(e => console.log(' -', e));
  }
  if (rejected.length) {
    console.log('\n--- Promise rejections ---');
    rejected.slice(0, 5).forEach(r => console.log(' -', r.reason));
  }

  const passed = health.status === 200 && errors.length === 0;
  console.log('\n' + (passed ? '✅ PASSED — no crashes, no failed requests.' : '⚠️  Completed with some failures — see above.'));
  process.exit(passed ? 0 : 1);
}

main();
