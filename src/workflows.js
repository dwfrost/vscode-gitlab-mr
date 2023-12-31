const vscode = require('vscode');
const open = require('opn');
const url = require('url');

const gitActions = require('./git');
const gitlabActions = require('./gitlab');
const gitUtils = require('./git-utils');

const message = msg => `Gitlab MR: ${msg}`;
const ERROR_STATUS = message('Unable to create MR.');
const STATUS_TIMEOUT = 10000;
const WIP_STRING = 'WIP:';
const CONFIG_NAMESPACE = 'gitlab-mr';

const showErrorMessage = msg => {
    vscode.window.showErrorMessage(message(msg));
    vscode.window.setStatusBarMessage(ERROR_STATUS, STATUS_TIMEOUT);
};

const showAccessTokenErrorMessage = gitlabApiUrl => {
    const tokenUrl = `${gitlabApiUrl}/profile/personal_access_tokens`;
    const errorMsg = gitlabApiUrl === 'https://gitlab.com' ?
        'gitlab-mr.accessToken preference not set.' :
        `gitlab-mr.accessTokens["${gitlabApiUrl}"] preference not set.`;

    const generateTokenLabel = 'Generate Access Token';

    return vscode.window.showErrorMessage(message(errorMsg), generateTokenLabel).then(selected => {
        switch (selected) {
            case generateTokenLabel:
                open(tokenUrl);
                break;
        }
    });
};

const selectWorkspaceFolder = async () => {
    if (vscode.workspace.workspaceFolders.length > 1) {
        const selected = await vscode.window.showQuickPick(vscode.workspace.workspaceFolders.map(folder => ({
            label: folder.name,
            folder
        })), {
            placeHolder: 'Select workspace folder',
            ignoreFocusOut: true
        });

        if (selected) {
            return selected.folder;
        }
    } else {
        return vscode.workspace.workspaceFolders[0];
    }
};

const buildGitlabContext = async workspaceFolderPath => {
    const preferences = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const targetRemote = preferences.get('targetRemote', 'origin');

    // Access tokens
    const gitlabComAccessToken = preferences.get('accessToken');
    const gitlabCeAccessTokens = preferences.get('accessTokens') || {};

    // Set git context
    const git = buildGitContext(workspaceFolderPath);

    const { repoId, repoHost } = await git.parseRemotes(targetRemote);
    const gitlabHosts = gitUtils.parseGitlabHosts(gitlabCeAccessTokens);
    const repoWebProtocol = gitUtils.parseRepoProtocol(repoHost, gitlabHosts);

    const gitlabApiUrl = url.format({
        host: repoHost,
        protocol: repoWebProtocol
    });
    const isGitlabCom = repoHost === 'gitlab.com';
    const accessToken = isGitlabCom ? gitlabComAccessToken : gitlabCeAccessTokens[gitlabApiUrl];

    // Token not set for repo host
    if (!accessToken) {
        return showAccessTokenErrorMessage(gitlabApiUrl);
    }

    // Build Gitlab context
    return gitlabActions({
        url: gitlabApiUrl,
        token: accessToken,
        repoId,
        repoHost,
        repoWebProtocol
    });
};

const buildGitContext = workspaceFolderPath => gitActions(workspaceFolderPath);

const openMR = async () => {
    const preferences = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);

    const targetRemote = preferences.get('targetRemote', 'origin');
    const autoCommitChanges = preferences.get('autoCommitChanges', false);
    const autoOpenMr = preferences.get('autoOpenMr', false);
    const openToEdit = preferences.get('openToEdit', false);
    const removeSourceBranch = preferences.get('removeSourceBranch', false);

    // Pick workspace
    const workspaceFolder = await selectWorkspaceFolder();
    if (!workspaceFolder) {
        return;
    }

    const workspaceFolderPath = workspaceFolder.uri.fsPath;

    // Set git context
    const git = buildGitContext(workspaceFolderPath);

    const gitlab = await buildGitlabContext(workspaceFolderPath);
    const useDefaultBranch = preferences.get('useDefaultBranch', false);

    const targetBranch = useDefaultBranch ?
        await gitlab.getRepo().then(repo => repo.default_branch) :
        preferences.get('targetBranch', 'master');

    const {
        currentBranch,
        onMaster,
        cleanBranch
    } = await git.checkStatus(targetBranch);

    const lastCommitMessage = await git.lastCommitMessage();

    // Prompt user for branch and commit message
    const branch = await vscode.window.showInputBox({
        prompt: 'Branch Name:',
        value: onMaster ? '' : currentBranch,
        ignoreFocusOut: true
    });

    // Validate branch name
    if (branch === '') {
        return showErrorMessage('Branch name must be provided.');
    }

    if (!branch) {
        return;
    }

    if (branch.indexOf(' ') > -1) {
        return showErrorMessage('Branch name must not contain spaces.');
    }

    if (branch === targetBranch) {
        return showErrorMessage(`Branch name cannot be the default branch name (${targetBranch}).`);
    }

    const buildStatus = vscode.window.setStatusBarMessage(message(`Building MR to ${targetBranch} from ${branch}...`));

    // If the branch is not clean, and autoCommitChanges is false,
    // prompt user if they want to commit changes.
    // Otherwise, commit changes.
    const commitChanges = !cleanBranch && !autoCommitChanges ? (
        await vscode.window.showQuickPick([
            { label: 'Yes', value: true },
            { label: 'No', value: false }
        ], {
            placeHolder: 'Commit current changes?',
            ignoreFocusOut: true
        })
            .then(selection => selection && selection.value)
    ) : true;

    if (commitChanges === undefined) {
        return;
    }

    // Prompt for commit message/mr title
    const mrTitle = await vscode.window.showInputBox({
        prompt: commitChanges ? 'Commit message / MR Title:' : 'MR Title:',
        value: commitChanges ? '' : lastCommitMessage,
        ignoreFocusOut: true
    });

    // Validate commit message
    if (!mrTitle === '') {
        return showErrorMessage('MR title must be provided.');
    }

    if (!mrTitle) {
        return;
    }

    // Build up chain of git commands to run
    let gitPromises;
    if (onMaster || (!onMaster && currentBranch !== branch)) {
        if (cleanBranch || !commitChanges) {
            gitPromises = git.createBranch(branch)
                .then(() => git.pushBranch(targetRemote, branch));
        } else {
            gitPromises = git.createBranch(branch)
                .then(() => git.addFiles('./*'))
                .then(() => git.commitFiles(mrTitle))
                .then(() => git.pushBranch(targetRemote, branch));
        }
    } else {
        if (cleanBranch || !commitChanges) {
            gitPromises = git.pushBranch(targetRemote, branch);
        } else {
            gitPromises = git.addFiles('./*')
                .then(() => git.commitFiles(mrTitle))
                .then(() => git.pushBranch(targetRemote, branch));
        }
    }

    await gitPromises
        .catch(err => {
            buildStatus.dispose();

            throw err;
        });

    return gitlab.openMr(branch, targetBranch, mrTitle, removeSourceBranch)
        .then(mr => {
            const successMessage = message(`MR !${mr.iid} created.`);
            const successButton = 'Open MR';

            buildStatus.dispose();
            vscode.window.setStatusBarMessage(successMessage, STATUS_TIMEOUT);

            const mrWebUrl = `${mr.web_url}${openToEdit ? '/edit': ''}`;

            if (autoOpenMr) {
                open(mrWebUrl);
                return vscode.window.showInformationMessage(successMessage);
            }

            return vscode.window.showInformationMessage(successMessage, successButton).then(selected => {
                switch (selected) {
                    case successButton: {
                        open(mrWebUrl);
                        break;
                    }
                }
            });
        })
        .catch(() => {
            buildStatus.dispose();

            const gitlabNewMrUrl = gitlab.buildMrUrl(branch, targetBranch);

            const createButton = 'Create on Gitlab';

            vscode.window.setStatusBarMessage(ERROR_STATUS, STATUS_TIMEOUT);
            vscode.window.showErrorMessage(ERROR_STATUS, createButton).then(selected => {
                switch (selected) {
                    case createButton:
                        open(gitlabNewMrUrl);
                        break;
                }
            });
        });
};

const listMRs = async workspaceFolderPath => {
    const preferences = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);

    const targetBranch = preferences.get('targetBranch', 'master');

    const gitlab = await buildGitlabContext(workspaceFolderPath);
    const mrs = await gitlab.listMrs();

    const mrList = mrs.map(mr => {
        const label = `MR !${mr.iid}: ${mr.title}`;
        const detail = mr.description;
        let description = `${mr.source_branch}`;

        if (mr.target_branch !== targetBranch) {
            description += ` > ${mr.target_branch}`;
        }

        return {
            mr,
            label,
            detail,
            description
        };
    });

    const selected = await vscode.window.showQuickPick(mrList, {
        matchOnDescription: true,
        placeHolder: 'Select MR',
        ignoreFocusOut: true
    });

    if (selected) {
        return selected.mr;
    }
};

const viewMR = async () => {
    const workspaceFolder = await selectWorkspaceFolder();
    if (!workspaceFolder) {
        return;
    }

    const mr = await listMRs(workspaceFolder.uri.fsPath);
    if (!mr) {
        return;
    }

    open(mr.web_url);
};

const checkoutMR = async () => {
    const preferences = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const targetRemote = preferences.get('targetRemote', 'master');

    const workspaceFolder  = await selectWorkspaceFolder();
    if (!workspaceFolder) {
        return;
    }

    const workspaceFolderPath = workspaceFolder.uri.fsPath;

    const mr = await listMRs(workspaceFolderPath);
    if (!mr) {
        return;
    }

    const git = buildGitContext(workspaceFolderPath);

    const checkoutStatus = vscode.window.setStatusBarMessage(message(`Checking out MR !${mr.iid}...`));

    return git.listBranches()
        .then(async branches => {
            const branchName = mr.source_branch;
            const targetBranch = branches.branches[branchName];

            if (targetBranch) {
                // Switch to existing branch
                return git.checkoutBranch([branchName]);
            }

            // Fetch and switch to remote branch
            await git.fetchRemote(targetRemote, branchName);
            return git.checkoutBranch(['-b', branchName, `${targetRemote}/${branchName}`]);
        })
        .then(() => {
            checkoutStatus.dispose();
            vscode.window.setStatusBarMessage(message(`Switched to MR !${mr.iid}.`), STATUS_TIMEOUT);
        })
        .catch(err => {
            checkoutStatus.dispose();
            showErrorMessage(err.message);
        });
};

const searchUsers = async gitlab => {
    const search = await vscode.window.showInputBox({
        placeHolder: 'Search for user...',
        ignoreFocusOut: true
    });

    if (search) {
        const users = await gitlab.searchUsers(search);

        if (users) {
            const userOptions = users.map(user => ({
                label: `${user.name} (${user.username})`,
                user
            }));

            const otherOptions = [
                { label: 'Search again...', searchAgain: true }
            ];

            const selection = await vscode.window.showQuickPick([
                ...userOptions,
                ...otherOptions
            ], {
                placeHolder: 'Select a user...'
            });

            if (selection.searchAgain) {
                return searchUsers(gitlab);
            }

            return selection;
        }
    }
};

const editMR = async () => {
    const workspaceFolder = await selectWorkspaceFolder();
    if (!workspaceFolder) {
        return;
    }

    const workspaceFolderPath = workspaceFolder.uri.fsPath;
    const mr = await listMRs(workspaceFolderPath);
    if (!mr) {
        return;
    }

    const gitlab = await buildGitlabContext(workspaceFolderPath);

    const editCommands = {
        editTitle: 'Edit title',
        setWip: mr.work_in_progress ? 'Remove WIP' : 'Set as WIP',
        editAssignee: mr.assignee ? `Edit assignee (${mr.assignee.username})`: 'Set assignee',
        removeAssignee: `Remove assignee ${mr.assignee ? `(${mr.assignee.username})` : ''}`,
        addApprovers: 'Add approvers'
    };

    const selected = await vscode.window.showQuickPick(Object.values(editCommands), {
        placeHolder: 'Select an action...',
        ignoreFocusOut: true
    });

    const showGitlabError = e => {
        showErrorMessage(e.error.error || e.error.message);
    };

    switch (selected) {
        case editCommands.editTitle:
            const title = await vscode.window.showInputBox({
                value: mr.title
            });

            if (title) {
                return gitlab.editMr(mr.iid, {
                    title
                })
                    .then(() => vscode.window.showInformationMessage(message(`MR !${mr.iid} title updated.`)))
                    .catch(showGitlabError);
            }
            break;

        case editCommands.setWip:
            return gitlab.editMr(mr.iid, {
                title: mr.work_in_progress ? mr.title.split(WIP_STRING)[1].trim() : `${WIP_STRING} ${mr.title}`
            })
                .then(updatedMr => vscode.window.showInformationMessage(message(`MR !${mr.iid} WIP ${updatedMr.work_in_progress ? 'added' : 'removed'}.`)))
                .catch(showGitlabError);

        case editCommands.editAssignee:
            const assignee = await searchUsers(gitlab);
            if (assignee) {
                return gitlab.editMr(mr.iid, {
                    assignee_id: assignee.user.id
                })
                    .then(() => vscode.window.showInformationMessage(message(`MR !${mr.iid} assignee set to ${assignee.user.username}`)))
                    .catch(showGitlabError);
            }
            break;

        case editCommands.removeAssignee:
            return gitlab.editMr(mr.iid, {
                assignee_id: null
            })
                .then(() => vscode.window.showInformationMessage(message(`MR !${mr.iid} assignee removed.`)))
                .catch(showGitlabError);

        case editCommands.addApprovers:
            const approvals = await gitlab.getApprovals(mr.iid);
            const approver = await searchUsers(gitlab);
            if (approver) {
                return gitlab.editApprovers(mr.iid, {
                    approver_ids: [
                        ...approvals.approvers.map(app => app.user.id),
                        approver.user.id
                    ],
                    approver_group_ids: [
                        ...approvals.approver_groups.map(app => app.group.id)
                    ]
                })
                    .then(() => vscode.window.showInformationMessage(message(`MR !${mr.iid} approver added.`)))
                    .catch(showGitlabError);
            }
            break;

        default:
            break;
    }
};

module.exports = {
    listMRs: () => listMRs().catch(e => showErrorMessage(e.message)),
    viewMR: () => viewMR().catch(e => showErrorMessage(e.message)),
    checkoutMR: () => checkoutMR().catch(e => showErrorMessage(e.message)),
    openMR: () => openMR().catch(e => showErrorMessage(e.message)),
    editMR: () => editMR().catch(e => showErrorMessage(e.message))
};
