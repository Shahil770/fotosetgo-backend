const { PrismaClient } = require('@prisma/client');
const { google } = require('googleapis');
require('dotenv').config();

const prisma = new PrismaClient();

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

async function main() {
  console.log('=== Checking Google Drive Folders for Photographers ===\n');
  const photographers = await prisma.photographer.findMany({
    where: { googleDriveConnected: true, googleDriveAccessToken: { not: null } },
  });

  if (photographers.length === 0) {
    console.log('No connected Google Drive photographers found.');
    return;
  }

  for (const pg of photographers) {
    console.log(`Photographer: ${pg.id} (${pg.studioName || pg.email || 'Unnamed'})`);
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials({
      access_token: pg.googleDriveAccessToken,
      refresh_token: pg.googleDriveRefreshToken,
    });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // List all folders in root
    const rootRes = await drive.files.list({
      q: "'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'files(id, name, createdTime)',
    });

    console.log(`Folders in Drive Root: ${rootRes.data.files?.length || 0}`);
    (rootRes.data.files || []).forEach(f => {
      console.log(`  - [${f.id}] "${f.name}" (created: ${f.createdTime})`);
    });

    // Check FotosetGo folders
    const fotosetgoFolders = (rootRes.data.files || []).filter(f => f.name === 'FotosetGo');
    if (fotosetgoFolders.length > 1) {
      console.log(`\n⚠️ FOUND ${fotosetgoFolders.length} DUPLICATE "FotosetGo" ROOT FOLDERS!`);
    }
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  prisma.$disconnect();
  process.exit(1);
});
