FROM public.ecr.aws/lambda/python:3.12

# Install system dependencies required by OpenCV and compilation
RUN dnf update -y && dnf install -y \
    mesa-libGL \
    glib2 \
    gcc \
    gcc-c++ \
    python3-devel \
    && dnf clean all

# Copy requirements first to leverage Docker cache
COPY requirements.txt ${LAMBDA_TASK_ROOT}

# Install dependencies (Remove fastapi/uvicorn if you want, or keep them it's fine)
RUN pip install --upgrade pip
RUN pip install --no-cache-dir -r requirements.txt

# Copy all source code and model files
COPY . ${LAMBDA_TASK_ROOT}

# Set the CMD to your handler (app.py -> lambda_handler function)
CMD [ "app.lambda_handler" ]
