// Public surface of shared-kernel/identity (E1-T04 · EES §2.1).
export type { Id, IdEntropy, IdGenerator } from './id.js';
export { ID_LENGTH, compareIds, createIdGenerator, isId, platformIds } from './id.js';
export type { DeviceId } from './device-id.js';
export { DEVICE_ID_LENGTH, createDeviceId, isDeviceId } from './device-id.js';
export type { Now, RandomBytes } from './entropy.js';
export { platformNow, platformRandomBytes, platformRandomBytesOrThrow } from './entropy.js';
