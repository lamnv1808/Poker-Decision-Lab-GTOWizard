// Preflight for `npm start`: fail fast with a plain explanation when required settings are missing.
const missing = ['DATABASE_URL', 'APP_SECRET'].filter((k) => !process.env[k] || !process.env[k].trim());
const url = process.env.DATABASE_URL ?? '';
if (url && !/^postgres(ql)?:\/\//.test(url)) missing.push('DATABASE_URL (must start with postgresql://)');
if (process.env.NODE_ENV === 'production' && missing.length) {
  console.error(`\nCONFIGURATION ERROR — missing environment variable(s): ${missing.join(', ')}`);
  console.error('Add them on the WEB SERVICE → Environment page (not on the database), save, then redeploy.');
  console.error('DATABASE_URL = your Postgres "Internal Database URL"; APP_SECRET = any long random string.\n');
  process.exit(1);
}
// Outside production the server reads apps/server/.env itself, so nothing else to check here.
