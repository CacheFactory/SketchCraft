#!/bin/bash
# Deploy the SKP conversion service to AWS App Runner.
# Wine requires a full Linux kernel — Lambda's Firecracker VM doesn't support it.
# App Runner auto-scales to zero and runs standard Docker containers.
#
# Prerequisites: docker built (docker build --platform linux/amd64 -t skp-convert .),
#                AWS CLI configured, Docker running.
set -euo pipefail
cd "$(dirname "$0")"

REGION="us-east-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="draftdown-skp-convert"
IMAGE_TAG="latest"
FULL_IMAGE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}:${IMAGE_TAG}"
SERVICE_NAME="draftdown-skp-convert"

echo "=== Step 1: Create ECR repository (if needed) ==="
aws ecr describe-repositories --repository-names "${ECR_REPO}" --region "${REGION}" 2>/dev/null || \
    aws ecr create-repository --repository-name "${ECR_REPO}" --region "${REGION}" \
        --image-scanning-configuration scanOnPush=true

echo "=== Step 2: Login to ECR ==="
aws ecr get-login-password --region "${REGION}" | \
    docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

echo "=== Step 3: Tag and push image ==="
docker tag skp-convert-lambda "${FULL_IMAGE}"
docker push "${FULL_IMAGE}"

echo "=== Step 4: Create/update App Runner service ==="

# Create App Runner ECR access role if needed
ROLE_NAME="draftdown-apprunner-ecr-role"
ROLE_ARN=$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.Arn' --output text 2>/dev/null || true)

if [ -z "${ROLE_ARN}" ] || [ "${ROLE_ARN}" = "None" ]; then
    echo "  Creating IAM role for App Runner ECR access..."
    ROLE_ARN=$(aws iam create-role \
        --role-name "${ROLE_NAME}" \
        --assume-role-policy-document '{
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Principal": {"Service": "build.apprunner.amazonaws.com"},
                "Action": "sts:AssumeRole"
            }]
        }' \
        --query 'Role.Arn' --output text)

    aws iam attach-role-policy \
        --role-name "${ROLE_NAME}" \
        --policy-arn "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"

    echo "  Waiting for role to propagate..."
    sleep 10
fi

# Check if service exists
SERVICE_ARN=$(aws apprunner list-services --query "ServiceSummaryList[?ServiceName=='${SERVICE_NAME}'].ServiceArn" --output text --region "${REGION}" 2>/dev/null || true)

if [ -n "${SERVICE_ARN}" ] && [ "${SERVICE_ARN}" != "None" ] && [ "${SERVICE_ARN}" != "" ]; then
    echo "  Updating existing App Runner service..."
    aws apprunner update-service \
        --service-arn "${SERVICE_ARN}" \
        --source-configuration "{
            \"ImageRepository\": {
                \"ImageIdentifier\": \"${FULL_IMAGE}\",
                \"ImageRepositoryType\": \"ECR\",
                \"ImageConfiguration\": {
                    \"Port\": \"8080\"
                }
            },
            \"AutoDeploymentsEnabled\": false,
            \"AuthenticationConfiguration\": {
                \"AccessRoleArn\": \"${ROLE_ARN}\"
            }
        }" \
        --instance-configuration '{
            "Cpu": "1 vCPU",
            "Memory": "2 GB"
        }' \
        --region "${REGION}"
else
    echo "  Creating new App Runner service..."
    SERVICE_ARN=$(aws apprunner create-service \
        --service-name "${SERVICE_NAME}" \
        --source-configuration "{
            \"ImageRepository\": {
                \"ImageIdentifier\": \"${FULL_IMAGE}\",
                \"ImageRepositoryType\": \"ECR\",
                \"ImageConfiguration\": {
                    \"Port\": \"8080\"
                }
            },
            \"AutoDeploymentsEnabled\": false,
            \"AuthenticationConfiguration\": {
                \"AccessRoleArn\": \"${ROLE_ARN}\"
            }
        }" \
        --instance-configuration '{
            "Cpu": "1 vCPU",
            "Memory": "2 GB"
        }' \
        --health-check-configuration '{
            "Protocol": "HTTP",
            "Path": "/",
            "Interval": 20,
            "Timeout": 5,
            "HealthyThreshold": 1,
            "UnhealthyThreshold": 5
        }' \
        --region "${REGION}" \
        --query 'Service.ServiceArn' --output text)
fi

echo "=== Step 5: Force deployment ==="
aws apprunner start-deployment --service-arn "${SERVICE_ARN}" --region "${REGION}" || true

echo "  Waiting for service to be ready..."
aws apprunner wait service-running --service-arn "${SERVICE_ARN}" --region "${REGION}" 2>/dev/null || \
    echo "  (wait not supported — check console for status)"

# Get service URL
SERVICE_URL=$(aws apprunner describe-service \
    --service-arn "${SERVICE_ARN}" \
    --region "${REGION}" \
    --query 'Service.ServiceUrl' --output text)

echo ""
echo "=== Deploy complete ==="
echo "  Service URL: https://${SERVICE_URL}"
echo ""
echo "  Set SKP_CONVERT_URL for web build:"
echo "    export SKP_CONVERT_URL=https://${SERVICE_URL}"
echo "    npm run build:web"
