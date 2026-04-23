#!/bin/bash
# Deploy the SKP conversion Lambda to AWS.
# Prerequisites: build.sh completed, AWS CLI configured, Docker running.
set -euo pipefail
cd "$(dirname "$0")"

REGION="us-east-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="draftdown-skp-convert"
LAMBDA_NAME="draftdown-skp-convert"
IMAGE_TAG="latest"
FULL_IMAGE="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}:${IMAGE_TAG}"

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

echo "=== Step 4: Create/update Lambda function ==="

# Check if Lambda exists
if aws lambda get-function --function-name "${LAMBDA_NAME}" --region "${REGION}" 2>/dev/null; then
    echo "  Updating existing Lambda..."
    aws lambda update-function-code \
        --function-name "${LAMBDA_NAME}" \
        --image-uri "${FULL_IMAGE}" \
        --region "${REGION}"

    # Wait for update to complete
    aws lambda wait function-updated --function-name "${LAMBDA_NAME}" --region "${REGION}"

    # Update configuration
    aws lambda update-function-configuration \
        --function-name "${LAMBDA_NAME}" \
        --timeout 300 \
        --memory-size 2048 \
        --ephemeral-storage '{"Size": 4096}' \
        --region "${REGION}"
else
    echo "  Creating new Lambda..."

    # Create IAM role if needed
    ROLE_NAME="draftdown-skp-convert-role"
    ROLE_ARN=$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.Arn' --output text 2>/dev/null || true)

    if [ -z "${ROLE_ARN}" ] || [ "${ROLE_ARN}" = "None" ]; then
        echo "  Creating IAM role..."
        ROLE_ARN=$(aws iam create-role \
            --role-name "${ROLE_NAME}" \
            --assume-role-policy-document '{
                "Version": "2012-10-17",
                "Statement": [{
                    "Effect": "Allow",
                    "Principal": {"Service": "lambda.amazonaws.com"},
                    "Action": "sts:AssumeRole"
                }]
            }' \
            --query 'Role.Arn' --output text)

        aws iam attach-role-policy \
            --role-name "${ROLE_NAME}" \
            --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"

        echo "  Waiting for role to propagate..."
        sleep 10
    fi

    aws lambda create-function \
        --function-name "${LAMBDA_NAME}" \
        --package-type Image \
        --code "ImageUri=${FULL_IMAGE}" \
        --role "${ROLE_ARN}" \
        --timeout 300 \
        --memory-size 2048 \
        --ephemeral-storage '{"Size": 4096}' \
        --region "${REGION}"

    aws lambda wait function-active --function-name "${LAMBDA_NAME}" --region "${REGION}"
fi

echo "=== Step 5: Configure Function URL ==="

# Create or get function URL
FUNC_URL=$(aws lambda get-function-url-config \
    --function-name "${LAMBDA_NAME}" \
    --region "${REGION}" \
    --query 'FunctionUrl' --output text 2>/dev/null || true)

if [ -z "${FUNC_URL}" ] || [ "${FUNC_URL}" = "None" ]; then
    FUNC_URL=$(aws lambda create-function-url-config \
        --function-name "${LAMBDA_NAME}" \
        --auth-type NONE \
        --cors '{
            "AllowOrigins": ["https://draftdownapp.com", "http://localhost:3001"],
            "AllowMethods": ["POST", "OPTIONS"],
            "AllowHeaders": ["Content-Type"],
            "MaxAge": 86400
        }' \
        --region "${REGION}" \
        --query 'FunctionUrl' --output text)

    # Allow public access
    aws lambda add-permission \
        --function-name "${LAMBDA_NAME}" \
        --statement-id "FunctionURLAllowPublicAccess" \
        --action "lambda:InvokeFunctionUrl" \
        --principal "*" \
        --function-url-auth-type NONE \
        --region "${REGION}" 2>/dev/null || true
fi

echo ""
echo "=== Deploy complete ==="
echo "  Function URL: ${FUNC_URL}"
echo ""
echo "  Update SKP_CONVERT_URL in webpack.web.config.js:"
echo "    __SKP_CONVERT_URL__: JSON.stringify('${FUNC_URL}')"
