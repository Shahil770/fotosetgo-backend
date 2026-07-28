/**
 * cleanup-drive-duplicates.js
 * Merges contents of duplicate Google Drive folders (e.g. multiple "FotosetGo" folders)
 * into the primary (oldest) folder and deletes the duplicates.
 */
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

async function moveContents(drive, sourceFolderId, targetFolderId) {
  let isTruncated = true;
  let pageToken = undefined;

  while (isTruncated) {
    const res = await drive.files.list({
      q: `'${sourceFolderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageToken,
    });

    const files = res.data.files || [];
    for (const file of files) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        // Check if target already has a folder with this name
        const existingRes = await drive.files.list({
          q: `'${targetFolderId}' in parents and name = '${file.name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          fields: 'files(id)',
        });

        if (existingRes.data.files && existingRes.data.files.length > 0) {
          // Merge contents recursively
          const targetSubFolderId = existingRes.data.files[0].id;
          console.log(`  [Merge Subfolder] "${file.name}": ${file.id} -> ${targetSubFolderId}`);
          await moveContents(drive, file.id, targetSubFolderId);
          // Delete duplicate subfolder
          try {
            await drive.files.delete({ fileId: file.id });
          } catch {}
          continue;
        }
      }


      // Move file or unique subfolder to targetFolder
      console.log(`  [Move File/Folder] Moving "${file.name}" (${file.id}) to ${targetFolderId}`);
      try {
        await drive.files.update({
          fileId: file.id,
          addParents: targetFolderId,
          removeParents: sourceFolderId,
          fields: 'id, parents',
        });
      } catch (err) {
        console.warn(`  [Warn] Failed to move ${file.name}: ${err.message}`);
      }
    }

    pageToken = res.data.nextPageToken;
    isTruncated = !!pageToken;
  }
}


async function cleanupDuplicatesForPhotographer(photographer) {
  console.log(`\n======================================================`);
  console.log(`Cleaning up Drive duplicates for: ${photographer.id}`);
  console.log(`======================================================`);

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    access_token: photographer.googleDriveAccessToken,
    refresh_token: photographer.googleDriveRefreshToken,
  });

  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  // 1. Find all "FotosetGo" folders in root
  const rootRes = await drive.files.list({
    q: "'root' in parents and name = 'FotosetGo' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: 'files(id, name, createdTime)',
    orderBy: 'createdTime asc',
  });

  const rootFolders = rootRes.data.files || [];
  if (rootFolders.length <= 1) {
    console.log(`✅ Root "FotosetGo" folder count: ${rootFolders.length} (no root duplicates)`);
  } else {
    console.log(`⚠️ Found ${rootFolders.length} "FotosetGo" root folders. Merging into primary: ${rootFolders[0].id}`);
    const primaryFolderId = rootFolders[0].id;

    for (let i = 1; i < rootFolders.length; i++) {
      const dup = rootFolders[i];
      console.log(`\nMerging duplicate root folder [${dup.id}] (${dup.name}) -> primary [${primaryFolderId}]...`);
      await moveContents(drive, dup.id, primaryFolderId);
      console.log(`Deleting empty duplicate root folder [${dup.id}]...`);
      await drive.files.delete({ fileId: dup.id });
    }
    console.log(`✅ Root "FotosetGo" folders consolidated!`);
  }

  // 2. Check for duplicate subfolders inside FotosetGo root
  const activeRoot = await drive.files.list({
    q: "'root' in parents and name = 'FotosetGo' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    fields: 'files(id)',
  });

  if (activeRoot.data.files && activeRoot.data.files.length > 0) {
    const mainRootId = activeRoot.data.files[0].id;
    const subRes = await drive.files.list({
      q: `'${mainRootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime asc',
    });

    const subFolders = subRes.data.files || [];
    const grouped = {};
    for (const folder of subFolders) {
      if (!grouped[folder.name]) grouped[folder.name] = [];
      grouped[folder.name].push(folder);
    }

    for (const [name, list] of Object.entries(grouped)) {
      if (list.length > 1) {
        console.log(`\n⚠️ Found ${list.length} duplicate subfolders for "${name}". Merging...`);
        const primarySubId = list[0].id;
        for (let i = 1; i < list.length; i++) {
          const dup = list[i];
          await moveContents(drive, dup.id, primarySubId);
          await drive.files.delete({ fileId: dup.id });
        }
      }
    }
  }
}

async function main() {
  const photographers = await prisma.photographer.findMany({
    where: { googleDriveConnected: true, googleDriveAccessToken: { not: null } },
  });

  for (const pg of photographers) {
    await cleanupDuplicatesForPhotographer(pg);
  }

  console.log('\n🎉 ALL DUPLICATES CLEANED UP SUCCESSFULLY!');
  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Error during cleanup:', err);
  prisma.$disconnect();
  process.exit(1);
});
