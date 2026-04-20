FROM public.ecr.aws/amazonlinux/amazonlinux:2023

WORKDIR /

# Copy the pre-built Go binary from its cmd directory
COPY src/cmd/write-server/bootstrap /bootstrap

# Copy necessary assets from the src directory
RUN mkdir -p /api/schema
COPY src/api/schema/schema.sql /api/schema/schema.sql

EXPOSE 8080

CMD ["/bootstrap"]
