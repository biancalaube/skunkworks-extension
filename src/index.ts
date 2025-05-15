// Documentation: https://sdk.netlify.com/docs
import { NetlifyExtension } from "@netlify/sdk";
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';


const extension = new NetlifyExtension();

extension.addBuildEventHandler("onPreBuild", () => {
  // If the build event handler is not enabled, return early
  if (!process.env["SKUNKWORKS_NETLIFY_EXTENSION_ENABLED"]) {
    return;
  }
});

extension.addBuildEventHandler('onSuccess', ({ utils }) => {
  console.log('Extension ran successfully. Checking if any files changed...');
  
  // --- Configuration (mirrors Python script) ---
const IGNORED_DIRS_FOR_NETLIFY_LINKS: Set<string> = new Set(['includes', 'images', 'examples'])
// File extensions to consider when scanning for include directives
const RELEVANT_FILE_EXTENSIONS: Set<string> = new Set(['.rst', '.txt'])


function createNetlifyMarkdownLink(fileRelPath: string, netlifyBaseUrl?: string): string {
    if (!netlifyBaseUrl) {
        return fileRelPath // Return plain path if no base URL
    }

    const pathParts = fileRelPath.split('/')
    if (pathParts.length === 0) return fileRelPath

    // Rule 1: Must be in 'source' directory (relative to repo root)
    if (pathParts[0] !== 'source') {
        return fileRelPath
    }

    // Rule 2: Check for ignored second-level directories (e.g., 'source/includes/')
    if (pathParts.length > 1 && IGNORED_DIRS_FOR_NETLIFY_LINKS.has(pathParts[1])) {
        return fileRelPath
    }

    let linkTargetPath = fileRelPath
    if (linkTargetPath.startsWith('source/')) {
        linkTargetPath = linkTargetPath.substring('source/'.length)
    } else if (linkTargetPath === 'source') { // Edge case for 'source' itself if it were a file
        linkTargetPath = ''
    }

    // Remove .txt or .rst extension for the link path
    if (linkTargetPath.endsWith('.txt')) {
        linkTargetPath = linkTargetPath.substring(0, linkTargetPath.length - '.txt'.length)
    } else if (linkTargetPath.endsWith('.rst')) {
        linkTargetPath = linkTargetPath.substring(0, linkTargetPath.length - '.rst'.length)
    }

    if (!linkTargetPath.startsWith('/')) {
        linkTargetPath = '/' + linkTargetPath
    }
    
    const finalNetlifyUrl = netlifyBaseUrl.replace(/\/$/, "") + linkTargetPath
    return `[${fileRelPath}](${finalNetlifyUrl})`
}

function getChangedFiles(repoPath: string, prBase: string, prHead: string): string[] {
    if (!prBase || !prHead) {
        console.error("Error: PR base or head branch not defined. Cannot run git diff.")
        return []
    }
    try {
        // For PRs, BRANCH..HEAD shows changes on HEAD since it forked from BRANCH.
        const command = `git diff --name-only "${prBase}..${prHead}"`
        console.log(`Executing: ${command} in ${repoPath}`)
        const result = execSync(command, { cwd: repoPath, encoding: 'utf-8', stdio: 'pipe' }) // stdio:pipe to avoid polluting build logs with just git output
        return result.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    } catch (e: any) {
        // Errors can happen if branches don't exist, or no common ancestor, or other git issues.
        // Log the error but don't fail the plugin; treat as no changes found.
        console.warn(`Warning: git diff command failed. Output: ${e.stdout}, Error: ${e.stderr}, Message: ${e.message}`)
        return []
    }
}

function extractIncludeFiles(filePath: string): string[] {
    const includeFiles: string[] = []
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            // console.warn(`File not found or not a file during include extraction: ${filePath}`);
            return []
        }
        const content = fs.readFileSync(filePath, 'utf-8')
        const lines = content.split('\n')
        for (const line of lines) {
            const trimmedLine = line.trim()
            if (trimmedLine.startsWith(".. include::") || trimmedLine.startsWith(".. literalinclude::")) {
                const parts = trimmedLine.split("::")
                if (parts.length > 1) {
                    const includePath = parts[1].trim()
                    if (includePath) {
                        includeFiles.push(includePath)
                    }
                }
            }
        }
    } catch (e: any) {
        // Log specific errors if needed, e.g., permission issues
        // console.error(`Error extracting includes from ${filePath}: ${e.message}`);
    }
    return includeFiles
}

interface ImpactDetails {
    [changedIncludeFileRelPath: string]: string[];
}
interface ResolveDependenciesResult {
    impactDetailsMap: ImpactDetails;
    directChanges: string[];
}

function* walkSync(dir: string): Generator<string> {
    let dirents: fs.Dirent[];
    try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err: any) {
        console.warn(`Could not read directory ${dir}: ${err.message}`);
        return; // Stop iteration for this path if unreadable
    }

    for (const dirent of dirents) {
        const fullPath = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
            // Avoid recursing into .git or node_modules for performance and relevance
            if (dirent.name === '.git' || dirent.name === 'node_modules') {
                continue;
            }
            yield* walkSync(fullPath);
        } else if (dirent.isFile()) {
            if (RELEVANT_FILE_EXTENSIONS.has(path.extname(dirent.name))) {
                 yield fullPath;
            }
        }
    }
}

function resolveIncludeDependencies(changedFilesFromGit: string[], directory: string): ResolveDependenciesResult {
    const includeDependencies: Map<string, Set<string>> = new Map() // abs_path_of_included_file -> Set<abs_paths_of_files_that_include_it>

    for (const currentFileAbsPath of walkSync(directory)) {
        const extractedIncludePaths = extractIncludeFiles(currentFileAbsPath)
        for (const includeDirectivePath of extractedIncludePaths) {
            let targetIncludeAbsPath = ""
            // Assuming Sphinx 'source' directory is at the root of 'directory' being scanned
            const sphinxSourceDirAbsolute = path.join(directory, "source")

            if (includeDirectivePath.startsWith('/')) {
                targetIncludeAbsPath = path.normalize(
                    path.join(sphinxSourceDirAbsolute, includeDirectivePath.substring(1))
                )
            } else {
                targetIncludeAbsPath = path.normalize(
                    path.join(path.dirname(currentFileAbsPath), includeDirectivePath)
                )
            }

            if (!includeDependencies.has(targetIncludeAbsPath)) {
                includeDependencies.set(targetIncludeAbsPath, new Set())
            }
            includeDependencies.get(targetIncludeAbsPath)!.add(currentFileAbsPath)
        }
    }

    const impactDetailsMap: ImpactDetails = {}
    const directChangesSet: Set<string> = new Set()

    for (const relPathFromGit of changedFilesFromGit) {
        const absPathFromGit = path.normalize(path.join(directory, relPathFromGit))

        if (includeDependencies.has(absPathFromGit)) {
            const containerAbsPaths = includeDependencies.get(absPathFromGit)!
            const containerRelPaths: Set<string> = new Set()
            for (const containerAbsPath of containerAbsPaths) {
                 // Ensure the container is within the scanned directory before taking relpath
                if (containerAbsPath.startsWith(directory + path.sep) || containerAbsPath === directory) { // Check if it's truly within
                    containerRelPaths.add(path.relative(directory, containerAbsPath))
                }
            }

            if (containerRelPaths.size > 0) {
                impactDetailsMap[relPathFromGit] = Array.from(containerRelPaths).sort()
            } else {
                // Changed file is known as an include target, but no valid containers were found. Treat as direct change.
                directChangesSet.add(relPathFromGit)
            }
        } else {
            directChangesSet.add(relPathFromGit)
        }
    }
    return {
        impactDetailsMap,
        directChanges: Array.from(directChangesSet).sort()
    }
}


const onSuccess = async ({ utils, constants }: { utils: any; constants: any }) => {
    const { BRANCH, HEAD, DEPLOY_PRIME_URL } = constants

    let netlifyDeployPrimeUrl = DEPLOY_PRIME_URL
    if (!netlifyDeployPrimeUrl) {
        console.warn("Warning: DEPLOY_PRIME_URL environment variable not set. Markdown links will be relative or incomplete.")
        // utils.status.show({ title: "Include Dependency Check", summary: "Warning: DEPLOY_PRIME_URL not set. Links may be affected." });
        // If DEPLOY_PRIME_URL is critical, you might choose to fail:
        // return utils.build.failPlugin("Error: DEPLOY_PRIME_URL environment variable not set.");
    }
    if (!BRANCH) {
        return utils.build.failPlugin("Error: BRANCH environment variable (PR base branch) not set.")
    }
    if (!HEAD) {
        return utils.build.failPlugin("Error: HEAD environment variable (PR head ref) not set.")
    }

    const directoryToScrape = process.cwd() // Assumes plugin runs from repo root

    try {
        const changedFilesFromGit = getChangedFiles(directoryToScrape, BRANCH, HEAD)
        
        if (changedFilesFromGit.length === 0) {
            utils.status.show({
                title: "Include Dependency Check",
                summary: "No file changes detected between specified branches.",
                text: `Compared base '${BRANCH}' with head '${HEAD}'. No relevant file changes found by git diff.`
            })
            return
        }
        console.log("Changed files from git:", changedFilesFromGit);


        const { impactDetailsMap, directChanges } = resolveIncludeDependencies(changedFilesFromGit, directoryToScrape)

        let overallChangesFound = false
        let markdownOutputLines: string[] = []

        if (Object.keys(impactDetailsMap).length > 0) {
            overallChangesFound = true
            markdownOutputLines.push("## Pages Impacted by Changes to Includes")
            const sortedIncludeFiles = Object.keys(impactDetailsMap).sort()

            for (const includeFileRelPath of sortedIncludeFiles) {
                const containerFilesRelPaths = impactDetailsMap[includeFileRelPath]
                const linkedIncludeFile = createNetlifyMarkdownLink(includeFileRelPath, netlifyDeployPrimeUrl)
                markdownOutputLines.push(`\n**Changed Include Page:** ${linkedIncludeFile}`)
                markdownOutputLines.push("  *Is included in:*")
                for (const containerFileRelPath of containerFilesRelPaths) {
                    const linkedContainerPath = createNetlifyMarkdownLink(containerFileRelPath, netlifyDeployPrimeUrl)
                    markdownOutputLines.push(`    - ${linkedContainerPath}`)
                }
            }
        }

        if (directChanges.length > 0) {
            overallChangesFound = true
            markdownOutputLines.push("\n## Other Directly Modified Pages")
            for (const fileRelPath of directChanges) {
                const linkedFilePath = createNetlifyMarkdownLink(fileRelPath, netlifyDeployPrimeUrl)
                markdownOutputLines.push(`- ${linkedFilePath}`)
            }
        } else if (Object.keys(impactDetailsMap).length > 0 && directChanges.length === 0) {
            // Only show this if there were include impacts but no *other* direct changes
            markdownOutputLines.push("\n## Other Directly Modified Pages")
            markdownOutputLines.push("(No other directly modified files)")
        }
        
        let summaryMessage = "Processed include dependencies for changed files."
        if (!overallChangesFound) {
            markdownOutputLines.push("\nNo documentation changes requiring review based on include dependencies.")
            summaryMessage = "No impactful documentation changes detected."
        }
        
        utils.status.show({
            title: "Documentation Include Dependency Check",
            summary: summaryMessage,
            text: markdownOutputLines.join('\n')
        })

    } catch (error: any) {
        utils.build.failPlugin(`Error in Include Dependency Check plugin: ${error.message}`, { error })
    }
}
});
  
export { extension };

