// Documentation: https://sdk.netlify.com/docs
import path from 'path';
import fs from 'fs';
import { NetlifyExtension } from "@netlify/sdk";

// Create a new Netlify extension
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

  const changedFiles = git.modifiedFiles.map((file: string) => file.replace(/^source\//, '')); // Normalize paths
  console.log("Normalized changed files from git:", changedFiles);

  const includesFolder = 'includes/';
  const impactedFilesMap: { [includeFile: string]: string[] } = {};

  for (const changedFile of changedFiles) {
    if (changedFile.startsWith(includesFolder)) {
      console.log(`Processing changed file: ${changedFile}`);
      // const includeFilePath = path.join(directoryToScrape, changedFile); // Not strictly needed if changedFile is used for map key

      // Find files that include this changed file
      for (const filePath of walkSync(directoryToScrape)) {
        // Ignore files starting with "bundle"
        if (path.basename(filePath).startsWith('bundle')) {
          // console.log(`Skipping bundle file: ${filePath}`);
          continue;
        }
        // Ignore files ending with ".bson"
        if (filePath.endsWith('.bson')) {
          // console.log(`Skipping .bson file: ${filePath}`);
          continue;
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const normalizedIncludePath = `/${changedFile}`; // Path in include directive e.g., /includes/file.rst
        if (content.includes(`.. include:: ${normalizedIncludePath}`) || content.includes(`.. literalinclude:: ${normalizedIncludePath}`)) {
          console.log(`Found include of '${changedFile}' in file: ${filePath}`);
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

  if (Object.keys(impactedFilesMap).length > 0) {
    for (const [includeFile, impactedFiles] of Object.entries(impactedFilesMap)) {
      markdownOutputLines.push(""); // Add a blank line for separation
      const includeFileText = includeFile || "UNKNOWN_OR_EMPTY_INCLUDE_FILE_PATH"; // Defensive check
      markdownOutputLines.push(`[Changed Include File]: ${includeFileText}`);
      markdownOutputLines.push("  Is included in:"); // Removed trailing \n here
      for (const impactedFile of impactedFiles) {
        const linkedImpactedFile = createNetlifyMarkdownLink(impactedFile, netlifyDeployPrimeUrl);
        markdownOutputLines.push(`    - ${linkedImpactedFile}`);
      }
    }
  } else {
    markdownOutputLines.push(""); // Add a blank line for separation
    markdownOutputLines.push("No files impacted by changes to included content.");
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

  let tempPath = fileRelPath;
  // First, remove 'source/' prefix if it exists, for the link path
  if (tempPath.startsWith('source/')) {
    tempPath = tempPath.substring('source/'.length);
  }
  // Then, remove 'includes/' prefix if it exists (for include files themselves when they are linked)
  tempPath = tempPath.replace(/^includes\//, '');

  // Remove file extensions
  let linkTargetPath = tempPath.replace(/\.txt$|\.rst$/, '');

  // Ensure it starts with a slash
  if (!linkTargetPath.startsWith('/')) {
    linkTargetPath = '/' + linkTargetPath;
  }

  const finalNetlifyUrl = netlifyBaseUrl.replace(/\/$/, '') + linkTargetPath;
  // The link text [fileRelPath] will still show the original path like 'source/...' or 'includes/...'
  return `[${fileRelPath}](${finalNetlifyUrl})`;
}

// Export the extension
export { extension };


