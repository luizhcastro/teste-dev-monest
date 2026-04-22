# Teste Técnico - Desenvolvedor

## Produção

API rodando em: **https://teste-dev-monest-production.up.railway.app**

- Endpoint: `GET /cep/{cep}`
- Swagger UI: https://teste-dev-monest-production.up.railway.app/docs
- Health: https://teste-dev-monest-production.up.railway.app/health/live

## O problema

Você precisa criar uma API que consulta CEP. Simples, certo?

Só que: você não controla as APIs externas. Elas caem, demoram, retornam erro. Seu serviço precisa continuar funcionando.

## APIs disponíveis

- ViaCEP: `https://viacep.com.br/ws/{cep}/json/`
- BrasilAPI: `https://brasilapi.com.br/api/cep/v1/{cep}`

## Requisitos

### Endpoint
`GET /cep/{cep}`

### Comportamento esperado
- Alterna entre as duas APIs (pode ser aleatório ou round-robin)
- Se uma falhar, tenta a outra automaticamente
- Retorna um contrato único, independente de qual API respondeu

### O que queremos ver

1. **Abstração** — Como você isola os providers externos? Se amanhã adicionarmos uma terceira API, o que muda no código?

2. **Resiliência** — O que acontece quando uma API demora 30 segundos? E quando as duas estão fora?

3. **Observabilidade** — Se der erro em produção, como a gente descobre o que aconteceu?

4. **Tratamento de erros** — Erros diferentes devem ter tratamentos diferentes. Timeout não é a mesma coisa que 404.

## Stack

NestJS + TypeScript. Fora isso, use o que fizer sentido.

## O que não estamos avaliando

- Frontend
- Banco de dados
- Deploy
- Cobertura de testes de 100%

## Como entregar

Fork este repositório, implemente, e envie o link para [matheus.morett@monest.com.br](mailto:matheus.morett@monest.com.br) com o assunto **Teste Dev - Monest**.

Se o repositório for privado, adicione `matheusmorett2` como colaborador.