module.exports = async function beforePack(context) {
  if (process.env.MEMO_THIN_UPDATE !== '1') return;
  const modelResources = new Set(['conomo', 'pnc', 'cleanup']);
  const resources = context.packager.config.extraResources || [];
  context.packager.config.extraResources = resources.filter(resource => {
    if (!resource || typeof resource === 'string') return true;
    return !modelResources.has(resource.to);
  });
  console.log('✓ Thin update excludes bundled model packs');
};
