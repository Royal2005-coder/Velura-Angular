import fs from 'node:fs';
import path from 'node:path';

/**
 * Ensures .vercel/project.json is present so Vercel CLI deploys to the correct project
 * without interactive prompts.
 */
function prepareProjectJson(appDir, projectName, projectId, orgId) {
  const dotVercel = path.join(appDir, '.vercel');
  fs.mkdirSync(dotVercel, { recursive: true });
  const pJson = {
    projectId: projectId || '',
    orgId: orgId || '',
    projectName: projectName
  };
  fs.writeFileSync(path.join(dotVercel, 'project.json'), JSON.stringify(pJson, null, 2));
}

/**
 * Prepares Vercel Build Output API v3 directory structure for Angular SPA.
 * Copies the Angular production browser build into .vercel/output/static and generates config.json.
 */
function prepareVercelOutput(appDir, distSubDir, projectName, projectId, orgId) {
  const outputDir = path.join(appDir, '.vercel', 'output');
  const staticDir = path.join(outputDir, 'static');
  const distDir = path.join(appDir, 'dist', distSubDir, 'browser');

  console.log(`Preparing Vercel output for ${projectName}...`);
  if (!fs.existsSync(distDir)) {
    throw new Error(`Dist directory not found: ${distDir}. Run npm run build first.`);
  }

  prepareProjectJson(appDir, projectName, projectId, orgId);

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(staticDir, { recursive: true });

  // Copy dist to .vercel/output/static
  fs.cpSync(distDir, staticDir, { recursive: true });

  // Create config.json with reverse proxy to API & Supabase, plus SPA routing
  const config = {
    version: 3,
    routes: [
      {
        src: "^/api/(.*)$",
        dest: "https://velura-api.vercel.app/api/$1"
      },
      {
        src: "^/supabase/(.*)$",
        dest: "https://gtyuajboeffmfskofoyh.supabase.co/$1"
      },
      {
        handle: "filesystem"
      },
      {
        src: "^/.*$",
        dest: "/index.html"
      }
    ]
  };

  fs.writeFileSync(path.join(outputDir, 'config.json'), JSON.stringify(config, null, 2));
  console.log(`✓ Prepared ${projectName} in ${outputDir}`);
}

const orgId = process.env.VERCEL_ORG_ID || 'team_4DOI11AsA0QdCuFjRPodp8jk';
const apiProjectId = process.env.VERCEL_PROJECT_ID_API || 'prj_aAVvpcf3cuxUGxqh68gub7dbZIvM';
const userProjectId = process.env.VERCEL_PROJECT_ID_USER || 'prj_hmtUCgs6pAZPkbJYqzVE9mG07gk4';
const adminProjectId = process.env.VERCEL_PROJECT_ID_ADMIN || 'prj_waCvvFA6uzEvNzKyvUnbFKzsSmOB';

prepareProjectJson('apps/api', 'velura-api', apiProjectId, orgId);
prepareVercelOutput('apps/user-ng', 'user-ng', 'velura-storefront', userProjectId, orgId);
prepareVercelOutput('apps/admin-ng', 'admin-ng', 'velura-admin', adminProjectId, orgId);
