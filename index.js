const core = require('@actions/core');
const exec = require('@actions/exec');
const glob = require('@actions/glob');

const executable = `${process.env.HOME}/google-java-format.jar`;
const apiReleases = 'https://api.github.com/repos/google/google-java-format/releases';

class ExecResult {
    constructor(exitCode, stdOut, stdErr) {
        this.exitCode = exitCode;
        this.stdOut = stdOut;
        this.stdErr = stdErr;
    }
}

async function executeGJF(args) {
    const arguments = ['-jar', executable].concat(args);
    const options = {
        cwd: process.env.GITHUB_WORKSPACE,
        ignoreReturnCode: true
    }
    const exitCode = await exec.exec('java', arguments, options);
    if (exitCode !== 0) {
        throw `Google Java Format failed with exit code ${exitCode}`;
    }

}

async function execute(command, { silent = false, ignoreReturnCode = false } = {}) {
    let stdErr = '';
    let stdOut = '';
    const options = {
        silent: silent,
        ignoreReturnCode: true,
        listeners: {
            stdout: (data) => stdOut += data.toString(),
            stderr: (data) => stdErr += data.toString(),
        }
    };
    core.debug(`Executing: ${command}`);
    const exitCode = await exec.exec(command, null, options);
    core.debug(`Exit code: ${exitCode}`);
    if (!ignoreReturnCode && exitCode !== 0) {
        throw `The command '${command}' failed with exit code ${exitCode}`;
    }
    return new ExecResult(exitCode, stdOut, stdErr);
}

async function getJavaVersion() {
    let javaVersion = await execute('java -version', { silent: !core.isDebug() });
    javaVersion = javaVersion.stdErr
        .split('\n')[0]
        .match(RegExp('[0-9\.]+'))[0];
    core.debug(`Extracted version number: ${javaVersion}`);
    if (javaVersion.startsWith('1.')) javaVersion = javaVersion.replace(RegExp('^1\.'), '');
    javaVersion = javaVersion.split('\.')[0];
    return parseInt(javaVersion);
}

async function getReleaseId() {
    let releaseId = 'latest';
    let releases = await execute(`curl -s "${apiReleases}"`, { silent: !core.isDebug() });
    releases = JSON.parse(releases.stdOut);
    core.debug(`releases is ${typeof releases}`);
    const findRelease = function (name) { return releases.find(r => r['name'] === name); };
    // Check if a specific version is requested
    const input = core.getInput('version');
    if (input !== undefined && input !== '') {
        const release = findRelease(input);
        if (release !== undefined) return release['id'];
        core.warning(`Version "${input}" of Google Java Format cannot be found. Fallback to latest.`);
    }
    const javaVersion = await getJavaVersion();
    if (isNaN(javaVersion)) core.warning('Cannot determine JDK version');
    else {
        core.info(`Version of JDK: ${javaVersion}`);
        if (javaVersion < 11) {
            // Versions after 1.7 require Java SDK 11+
            core.warning('Latest versions of Google Java Format require Java SDK 11 min. Fallback to Google Java Format 1.7.');
            releaseId = findRelease('1.7')['id'];
            if (releaseId === undefined) throw 'Cannot find release id of Google Java Format 1.7';
        }
    }
    return releaseId;
}

async function run() {
    try {
        // Get Google Java Format executable and save it to [executable]
        const releaseId = await getReleaseId();
        await core.group('Downloading Google Java Format', async () => {
            const urlRelease = `${apiReleases}/${releaseId}`;
            core.debug(`URL: ${urlRelease}`);
            let release = await execute(`curl -s "${urlRelease}"`, { silent: true });
            release = JSON.parse(release.stdOut);
            core.debug(`release is ${typeof release}`);
            const assets = release['assets'];
            core.debug(`assets is ${typeof assets}`);
            const downloadUrl = assets.find(asset => asset['name'].endsWith('all-deps.jar'))['browser_download_url'];
            core.info(`Downloading executable to ${executable}`);
            await execute(`curl -sL ${downloadUrl} -o ${executable}`, { silent: !core.isDebug() });
            await executeGJF(['--version']);
        });

        // Execute Google Java Format with provided arguments
        const args = core.getInput('args').split(' ');
        core.debug(`Arguments: ${args}`);
        const files = await (await glob.create(core.getInput('files'))).glob();
        core.debug(`Files:`);
        for (const file of files) {
            core.debug(`* ${file}`);
            args.push(file);
        }
        await executeGJF(args);

        // Commit changed files if there are any and if skipCommit != true
        if (core.getInput('skipCommit').toLowerCase() !== 'true') {
            await core.group('Committing changes', async () => {
                await execute('git config user.name github-actions', { silent: true });
                await execute("git config user.email ''", { silent: true });
                const diffIndex = await execute('git diff-index --quiet HEAD', { ignoreReturnCode: true, silent: true });
                if (diffIndex.exitCode !== 0) {
                    await execute('git commit --all -m "Google Java Format"');
                    await execute('git push');
                } else core.info('Nothing to commit!')
            });
        }
    } catch (message) {
        core.setFailed(message);
    }
}

run()
