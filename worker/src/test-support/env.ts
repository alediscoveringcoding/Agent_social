// Imported first by tests that load modules which read the config at import
// time. Fixed fake values, so a developer's worker/.env (dotenv never overrides
// what is already set) cannot leak a real key or URL into a test. No test
// ever calls a real AI API: the clients are mocked.
process.env.WORKER_TOKEN = "test-worker-token-0123456789abcdef0123456789";
process.env.WORKER_ID = "worker-test-01";
process.env.POSTIZ_API_KEY = "test-postiz-key";
process.env.POSTIZ_BASE_URL = "http://127.0.0.1:9";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
process.env.GEMINI_API_KEY = "test-gemini-not-a-real-key";
process.env.GENERATOR_PROVIDER = "claude";
process.env.GENERATOR_MODEL = "claude-opus-5-5";
process.env.GEMINI_MODEL = "gemini-3.8-flash";
process.env.WORKER_DRY_RUN = "true";
process.env.SITE_BASE_URL = "http://127.0.0.1:9";
process.env.GENERATOR_EFFORT = "medium";
process.env.GENERATION_HEARTBEAT_MS = "120000";
process.env.RESEARCH_MAX_SEARCHES = "5";
process.env.RESEARCH_TIMEOUT_MS = "";

// Never read a developer's real private style pack in tests.
process.env.STYLE_PACK_DIR = "/nonexistent/style-pack-for-tests";

export {};
