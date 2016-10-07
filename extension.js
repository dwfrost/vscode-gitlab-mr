const vscode = require('vscode');
const open = require('opn');
const gitlab = require('gitlab')
const simpleGit = require('simple-git');

function activate(context) {
    const makeMrFromMaster = vscode.commands.registerCommand('extension.makeMrFromMaster', () => {
        // Get preferences and connect to gitlab
        const preferences = vscode.workspace.getConfiguration('gitlab');
        const gitlabApi = gitlab({
            url: preferences.get('url'),
            token: preferences.get('token')
        });

        // Set git context
        const git = simpleGit(vscode.workspace.rootPath);

        vscode.window.showInputBox({
            prompt: 'Branch Name:'
        }).then(branch => {
            vscode.window.showInputBox({
                prompt: 'Commit Messaage:'
            }).then(commit_message => {
                git.checkout(['-b', branch])
                    .add('./*')
                    .commit(commit_message)
                    .push(['-u', 'origin', branch])
                    .getRemotes(true, (err, data) => {
                        const repo_url = data[0].refs.push;
                        const repo_id = repo_url.split(":")[1].split(".git")[0];

                        gitlabApi.projects.merge_requests.add(repo_id, branch, 'master', null, commit_message, data => {
                            open(data.web_url);
                        });
                    });
            });
        });
    });

    context.subscriptions.push(makeMrFromMaster);
}

exports.activate = activate;

function deactivate() { }

exports.deactivate = deactivate;