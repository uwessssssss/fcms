# FCMS API -- built and run in containers (deploy/docker-compose.yml).
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY Fcms.Api.csproj .
RUN dotnet restore
COPY . .
# Warnings are errors here too (Fcms.Api.csproj): an image is never built from
# code that would not pass check-all.sh step 6.
RUN dotnet publish -c Release -o /out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://+:5000 \
    ASPNETCORE_ENVIRONMENT=Production
EXPOSE 5000
# The non-root user the .NET 8 images ship with.
USER app
ENTRYPOINT ["dotnet", "Fcms.Api.dll"]
