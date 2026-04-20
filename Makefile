.PHONY: install dev build start test test-watch test-cov test-e2e test-all lint format docker docker-build docker-up docker-down clean

install:
	npm install

dev:
	npm run start:dev

build:
	npm run build

start: build
	npm run start:prod

test:
	npm test

test-watch:
	npm run test:watch

test-cov:
	npm run test:cov

test-e2e:
	npm run test:e2e

test-all: test test-e2e

lint:
	npm run lint

format:
	npm run format

docker-build:
	docker compose build

docker-up:
	docker compose up -d

docker-down:
	docker compose down

docker:
	docker compose up --build

clean:
	rm -rf dist node_modules coverage
