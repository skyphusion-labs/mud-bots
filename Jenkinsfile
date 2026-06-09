// Jenkins pipeline for mud-bots (the Packet Wastes + Hollow Grid AI players).
//
// What it does: lints the bots (syntax only -- there is no test suite by design),
// and on push to main, rsyncs the code to the GPU boxes (stan, wendy) and
// rolling-restarts their user bot services. The bots are plain interpreted code
// with no build step, so landing on main IS the release (like skyphusion.net).
// Non-main branches are linted but never deployed.
//
// Jenkins job: a multibranch pipeline (GitHub source SkyPhusion/mud-bots, branch
// discovery, Script Path Jenkinsfile) on mindcrime (`agent any`, host node/python).
//
// Credentials (Jenkins -> Manage Credentials):
//   mudbots-deploy   SSH Username with private key (user "ubuntu"); its public
//                    key is in ubuntu@stan / ubuntu@wendy authorized_keys. Bound
//                    with withCredentials(sshUserPrivateKey) and handed to
//                    deploy.sh as MUDBOTS_SSH_KEY for rsync + remote restarts.
// Uses credentials-binding (ssh-agent plugin is not installed here).

pipeline {
    agent any

    options {
        timeout(time: 15, unit: 'MINUTES')
        timestamps()
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '30'))
    }

    stages {
        stage('checkout') {
            steps {
                checkout scm
                script {
                    env.GIT_REF = (env.BRANCH_NAME ?: env.GIT_BRANCH ?: '')
                        .replaceFirst(/^origin\//, '')
                    echo "ref: ${env.GIT_REF ?: '(unknown)'}"
                }
            }
        }

        stage('lint') {
            steps {
                // Dependency-free Node bots + the Python suite: syntax-check all.
                sh 'node --check hollow-grid/bot.mjs'
                sh 'node --check discord/bot.mjs'
                sh 'python3 -m py_compile bot.py onboard.py mapper.py tutorial.py revive.py'
            }
        }

        stage('deploy') {
            // Only main reaches the fleet; side branches stop after a green lint.
            when {
                expression { return env.GIT_REF == 'main' }
            }
            steps {
                // The deploy key lets rsync + the remote systemctl --user reach the
                // boxes; deploy.sh does the rest (rolling restart, idempotent).
                withCredentials([sshUserPrivateKey(credentialsId: 'mudbots-deploy', keyFileVariable: 'MUDBOTS_SSH_KEY')]) {
                    sh 'bash deploy.sh'
                }
            }
        }
    }

    post {
        success {
            script {
                if (env.GIT_REF == 'main') {
                    echo 'Deployed mud-bots to stan + wendy.'
                } else {
                    echo "Branch '${env.GIT_REF}' linted (not deployed)."
                }
            }
        }
        failure {
            echo 'Build failed. Check the lint / deploy logs above.'
        }
        always {
            cleanWs(notFailBuild: true)
        }
    }
}
