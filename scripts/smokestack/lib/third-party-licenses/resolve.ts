// smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
// smokestack; every repository that takes it holds a byte-identical copy.

/** @public */
export { readJson } from '../license-core/manifest.ts';
/** @public */
export {
	readLicenseText,
	readNoticeText,
	resolveInstalledPackage as resolveVersionedDir,
} from '../license-core/resolve.ts';
