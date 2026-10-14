/**
 * 测试基建共享库 barrel —— docs/16-d §D6 测试基建契约
 */
export { seedFixtures, destroyFixtures, getFixtures, type SeededFixture } from './fixtures';
export {
  loginSystem,
  loginAdmin,
  loginCustomer,
  getApiKey,
  writeTokensFile,
  readTokensFile,
  type TokensFile,
  type TenantCode,
} from './auth';
export {
  systemHttp,
  adminHttp,
  apiKeyHttp,
  withReauth,
  allHttpFromTokensFile,
  allHttpFresh,
  type AllHttp,
} from './http';
