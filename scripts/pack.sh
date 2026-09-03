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

# 5) prázdne priečinky nech v ZIPe prežijú
printf 'Tento priečinok musí byť zapisovateľný.\n' > "$STAGE"/storage/logs/.keep
printf 'Sem sa ukladajú maily pri transport = log.\n' > "$STAGE"/storage/mail/.keep

cd "$STAGE"
zip -r -q /home/user/blup/enzo-web.zip . -x '.DS_Store' '__MACOSX/*'
cd /home/user/blup
echo "hotovo"
