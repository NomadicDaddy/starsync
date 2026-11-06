// smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
// smokestack; every repository that takes it holds a byte-identical copy.

export { readJson } from '../license-core/manifest.ts';
export {
	readLicenseText,
	readNoticeText,
	resolveInstalledPackage as resolveVersionedDir,
} from '../license-core/resolve.ts';
