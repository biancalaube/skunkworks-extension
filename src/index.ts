// Documentation: https://sdk.netlify.com/docs
import path from 'path';
import fs from 'fs';
import { NetlifyExtension } from "@netlify/sdk";

// Helper function to convert environment variables to boolean
function envVarToBool(value?: string): boolean {
  return value === 'true';
}

const isEnabled = envVarToBool(process.env.GIT_CHANGED_FILES_ENABLED);

if (isEnabled) {
  const extension = new NetlifyExtension();

  extension.addBuildEventHandler('onSuccess', ({ utils: { status, git } }) => {
    console.log('Checking if any files changed on git -----');

    // Check if git utilities are available
    if (!git || !git.modifiedFiles) {
      console.warn("Git utilities are not available. Skipping file change detection.");
      status.show({
        title: "Documentation Include Dependency Check",
        summary: "Git utilities are not available.",
        text: "The plugin could not detect changed files because Git utilities are unavailable in this environment.",
      });
      return;
    }

    const DEPLOY_PRIME_URL = process.env.DEPLOY_PRIME_URL || '';
    console.log('Netlify Deploy Prime URL:', DEPLOY_PRIME_URL);

    const netlifyDeployPrimeUrl = DEPLOY_PRIME_URL || '';
    const directoryToScrape = process.cwd();

    const changedFiles = git.modifiedFiles || [];
    console.log("Changed files from git:", changedFiles);

    const includesFolder = 'source/includes/';
    const impactedFilesMap: { [includeFile: string]: string[] } = {};

    for (const changedFile of changedFiles) {
      if (changedFile.startsWith(includesFolder)) {
        const includeFilePath = path.join(directoryToScrape, changedFile);

        // Find files that include this changed file
        for (const filePath of walkSync(directoryToScrape)) {
          const content = fs.readFileSync(filePath, 'utf-8');
          if (content.includes(`.. include:: ${changedFile}`) || content.includes(`.. literalinclude:: ${changedFile}`)) {
            const relativeFilePath = path.relative(directoryToScrape, filePath);
            if (!impactedFilesMap[changedFile]) {
              impactedFilesMap[changedFile] = [];
            }
            impactedFilesMap[changedFile].push(relativeFilePath);
          }
        }
      }
    }

    // Generate Markdown output
    const markdownOutputLines: string[] = [];
    markdownOutputLines.push("--- Files impacted by changes to included content ---");

    for (const [includeFile, impactedFiles] of Object.entries(impactedFilesMap)) {
      const linkedIncludeFile = createNetlifyMarkdownLink(includeFile, netlifyDeployPrimeUrl);
      markdownOutputLines.push(`\n[Changed Include File]: ${linkedIncludeFile}`);
      markdownOutputLines.push("  Is included in:");
      for (const impactedFile of impactedFiles) {
        const linkedImpactedFile = createNetlifyMarkdownLink(impactedFile, netlifyDeployPrimeUrl);
        markdownOutputLines.push(`    - ${linkedImpactedFile}`);
      }
    }

    if (markdownOutputLines.length === 1) {
      markdownOutputLines.push("\nNo files impacted by changes to included content.");
    }

    status.show({
      title: "Documentation Include Dependency Check",
      summary: "Processed include dependencies for changed files.",
      text: markdownOutputLines.join('\n'),
    });

    console.log("Markdown output lines:", markdownOutputLines);
  });

  // Helper function to walk through directories
  function* walkSync(dir: string): Generator<string> {
    const dirents = fs.readdirSync(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const fullPath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (dirent.name === '.git' || dirent.name === 'node_modules') continue;
        yield* walkSync(fullPath);
      } else if (dirent.isFile()) {
        yield fullPath;
      }
    }
  }

  // Helper function to create Netlify Markdown links
  function createNetlifyMarkdownLink(fileRelPath: string, netlifyBaseUrl?: string): string {
    if (!netlifyBaseUrl) return fileRelPath;

    let linkTargetPath = fileRelPath.replace(/^source\//, '').replace(/\.txt$|\.rst$/, '');
    if (!linkTargetPath.startsWith('/')) linkTargetPath = '/' + linkTargetPath;

    const finalNetlifyUrl = netlifyBaseUrl.replace(/\/$/, '') + linkTargetPath;
    return `[${fileRelPath}](${finalNetlifyUrl})`;
  }
}

