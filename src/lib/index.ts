/**
 * Lib / 通用工具 barrel
 */
export { AppError, ValidationError, AuthError, NotFoundError } from './errors';
export { hashPassword, verifyPassword } from './password';
export {
  signToken,
  verifyToken,
  type JwtPayload,
  type SystemJwtPayload,
  type TenantUserJwtPayload,
} from './jwt';
export {
  tenantCodeSchema,
  roleSchema,
  createUserSchema,
  updateUserSchema,
  changePasswordSchema,
  createTenantSchema,
  updateTenantSchema,
  updateTenantExpiresAtSchema,
  updateTenantStatusSchema,
  resetTenantAdminPasswordSchema,
} from './validators';
export {
  isAccountLocked,
  throwIfLocked,
  recordFailedLogin,
  recordSuccessfulLogin,
  MAX_FAILED_ATTEMPTS,
  LOCK_DURATION_MIN,
} from './login-lock';
export { writeAuditLog, type WriteAuditLogParams } from './audit-log';
export { assertTenantAccessible } from './tenant-gate';
