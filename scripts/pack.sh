set -e
cd /home/user/blup
STAGE=/tmp/enzopack
rm -rf "$STAGE" enzo-web.zip
mkdir -p "$STAGE"

# 1) statický web
cp -r out/. "$STAGE"/

# 2) backend
cp -r backend/api backend/admin "$STAGE"/
cp backend/install.php "$STAGE"/
mkdir -p "$STAGE"/storage/logs "$STAGE"/storage/mail
cp backend/storage/.htaccess "$STAGE"/storage/.htaccess

# 3) konfigurácia s heslami sa NIKDY nebalí
rm -f "$STAGE"/api/config.php
rm -f "$STAGE"/storage/*.sqlite

# 4) návod
cp NAVOD-WEBSUPPORT.md "$STAGE"/NAVOD.md

# 5) odtlačky súborov — aby sa v admine dalo overiť, či prenos prešiel celý
python3 - "$STAGE" <<'PYPACK'
import hashlib, json, os, sys, datetime

stage = sys.argv[1]
roots = ['api', 'admin', 'images']
extra = ['install.php', '.htaccess']
skip  = {'api/config.php', 'api/lib/manifest.json'}

files = {}
for root in roots:
    base = os.path.join(stage, root)
    for dirpath, _dirs, names in os.walk(base):
        for name in sorted(names):
            full = os.path.join(dirpath, name)
            rel  = os.path.relpath(full, stage).replace(os.sep, '/')
            if rel in skip:
                continue
            with open(full, 'rb') as fh:
                files[rel] = hashlib.sha1(fh.read()).hexdigest()

for rel in extra:
    full = os.path.join(stage, rel)
    if os.path.isfile(full):
        with open(full, 'rb') as fh:
            files[rel] = hashlib.sha1(fh.read()).hexdigest()

manifest = {
    'generated': datetime.datetime.now(datetime.timezone.utc)
        .strftime('%Y-%m-%d %H:%M:%S UTC'),
    'files': dict(sorted(files.items())),
}
with open(os.path.join(stage, 'api', 'lib', 'manifest.json'), 'w', encoding='utf-8') as fh:
    json.dump(manifest, fh, ensure_ascii=False, indent=1, sort_keys=True)
print(f'manifest: {len(files)} súborov')
PYPACK

# 6) prázdne priečinky nech v ZIPe prežijú
printf 'Tento priečinok musí byť zapisovateľný.\n' > "$STAGE"/storage/logs/.keep
printf 'Sem sa ukladajú maily pri transport = log.\n' > "$STAGE"/storage/mail/.keep

cd "$STAGE"
zip -r -q /home/user/blup/enzo-web.zip . -x '.DS_Store' '__MACOSX/*'
cd /home/user/blup
echo "hotovo"
