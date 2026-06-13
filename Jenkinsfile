// Jenkins pipeline for mud-bots (the Packet Wastes + Hollow Grid AI players).
//
// Stages:
//   checkout  - check out source, detect ref type (branch vs. tag)
//   lint      - syntax-check all bots (no test suite by design)
//   build     - build Docker images for hg-bot, pw-bot, discord-bot (tags only)
//   push      - push images to GHCR as :latest + :<tag> (tags only)
//
// Bots run as containerized Docker stacks on wendy (all bots as of 2026-06-10).
// Deployment is done by updating the stack compose file and redeploying -- no
// rsync or systemd path remains. The mudbots-deploy SSH credential is no longer
// used by CI.
//
// Credentials (Jenkins -> Manage Credentials):
//   ghcr-skyphusion   Username/password for ghcr.io (user=skyphusion-strummer,
//                     pass=PAT with write:packages scope).
//
// Jenkins runs on dischord (ci.skyphusion.org) directing the HEL1 fleet agents.

pipeline {
    agent { label 'build' }

    options {
        timeout(time: 20, unit: 'MINUTES')
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
                    // TAG_NAME is set by multibranch tag discovery; GIT_REF stays
                    // the branch/tag name for display, IS_TAG gates image builds.
                    env.IS_TAG = (env.TAG_NAME != null && env.TAG_NAME != '').toString()
                    echo "ref: ${env.GIT_REF ?: '(unknown)'}  is_tag: ${env.IS_TAG}"
                }
            }
        }

        stage('lint') {
            steps {
                sh 'node --check hollow-grid/bot.mjs'
                sh 'node --check discord/bot.mjs'
                sh 'python3 -m py_compile bot.py onboard.py mapper.py tutorial.py revive.py'
            }
        }

        stage('build') {
            when {
                expression { return env.IS_TAG == 'true' }
            }
            steps {
                sh 'docker build -t mud-bots-hg:build      -f hollow-grid/Dockerfile hollow-grid/'
                sh 'docker build -t mud-bots-pw:build      -f Dockerfile .'
                sh 'docker build -t mud-bots-discord:build -f discord/Dockerfile   discord/'
            }
        }

        stage('push') {
            when {
                expression { return env.IS_TAG == 'true' }
            }
            steps {
                withCredentials([usernamePassword(
                    credentialsId: 'ghcr-skyphusion',
                    usernameVariable: 'GHCR_USER',
                    passwordVariable: 'GHCR_TOKEN'
                )]) {
                    sh 'echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin'
                    script {
                        // In multibranch tag builds TAG_NAME is unset; the tag
                        // name comes through as BRANCH_NAME (e.g. "v1.0.0").
                        def tag = env.BRANCH_NAME
                        def images = [
                            ['mud-bots-hg:build',      'ghcr.io/skyphusion-labs/mud-bots-hg'],
                            ['mud-bots-pw:build',      'ghcr.io/skyphusion-labs/mud-bots-pw'],
                            ['mud-bots-discord:build', 'ghcr.io/skyphusion-labs/mud-bots-discord'],
                        ]
                        images.each { pair ->
                            def local  = pair[0]
                            def remote = pair[1]
                            sh "docker tag  ${local} ${remote}:${tag}"
                            sh "docker tag  ${local} ${remote}:latest"
                            sh "docker push ${remote}:${tag}"
                            sh "docker push ${remote}:latest"
                        }
                    }
                }
            }
        }

    }

    post {
        success {
            script {
                if (env.IS_TAG == 'true') {
                    echo "Built + pushed images for tag ${env.TAG_NAME}."
                } else {
                    echo "Branch '${env.GIT_REF}' linted."
                }
            }
        }
        failure {
            echo 'Build failed. Check the lint / build / deploy logs above.'
        }
        always {
            sh 'docker logout ghcr.io || true'
            cleanWs(notFailBuild: true)
        }
    }
}
