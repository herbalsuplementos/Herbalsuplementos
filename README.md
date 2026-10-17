# Herbal Suplementos

Site institucional responsivo com catálogo dinâmico e painel administrativo para a Herbal Suplementos. O projeto usa Node.js, Express e MongoDB. Os documentos são armazenados no MongoDB e as imagens são armazenadas como arquivos no GridFS, com referências nos documentos de produtos e conteúdo.

## Requisitos

- Node.js 20 ou superior.
- MongoDB local ou uma instância MongoDB acessível pela aplicação.

## Estrutura

```text
index.html                 Site público
css/style.css              Estilos públicos
Js/app.js                  Catálogo e conteúdo públicos via API
admin/index.html           Login e interface administrativa
admin/admin.js             Operações do painel
admin/admin.css            Estilos administrativos
server.js                  API, autenticação, validação e GridFS
scripts/create-admin.js    Criação única do primeiro administrador
.env.example               Modelo de configuração sem segredos
```

## Executar localmente

### Preparação inicial (uma vez)

1. Abra o terminal na pasta do projeto: `cd C:\Site-Herbal-main`.
2. Instale as dependências com `npm install`.
3. Copie `.env.example` para `.env` e configure `MONGODB_URI`, `SESSION_SECRET` e `SITE_ORIGIN`.
4. Inicialize os dados padrão com `npm run seed`.
5. Crie as contas administrativas seguindo o procedimento abaixo.

### Iniciar o site

No terminal, dentro de `C:\Site-Herbal-main`, rode:

```powershell
npm run dev
```

Abra `http://localhost:3000` no navegador. O painel administrativo fica em `http://localhost:3000/admin/`. Para parar o servidor, use `Ctrl+C` no terminal onde `npm run dev` está rodando.

O modo de desenvolvimento observa alterações nos arquivos e reinicia o servidor automaticamente. Para iniciar sem esse modo de observação, use `npm start`.

Se a porta 3000 já estiver ocupada, pare a outra instância do site com `Ctrl+C` no terminal dela. Alternativamente, inicie em outra porta — configure `PORT` e `SITE_ORIGIN` para a mesma porta:

```powershell
$env:PORT = "3001"
$env:SITE_ORIGIN = "http://localhost:3001"
npm run dev
```

Nesse caso, abra `http://localhost:3001`. Para voltar à porta padrão depois, feche esse processo com `Ctrl+C` e abra um novo terminal.

Exemplo de `.env` local (substitua o segredo; não use este valor em produção):

```dotenv
NODE_ENV=development
PORT=3000
MONGODB_URI=mongodb://127.0.0.1:27017/herbal_suplementos
SESSION_SECRET=
SITE_ORIGIN=http://localhost:3000
TRUST_PROXY=0
```

Não envie `.env` ao repositório. Em produção, configure essas variáveis no serviço de hospedagem e use HTTPS.
Se o TLS terminar em exatamente um proxy reverso confiável, defina `TRUST_PROXY=1`; mantenha `0` quando o processo receber conexões diretamente.

## Contas administrativas

Não há cadastro público. Cada conta é provisionada localmente com `ADMIN_USERNAME` e `ADMIN_PASSWORD`; o nome de usuário aceita letras, números, hífen e sublinhado e não diferencia maiúsculas de minúsculas. A senha deve ter no mínimo 12 caracteres.

PowerShell:

```powershell
$env:ADMIN_USERNAME = "ADM"
$env:ADMIN_PASSWORD = Read-Host "Senha forte (mínimo 12 caracteres)"
npm run create-admin
Remove-Item Env:ADMIN_USERNAME
Remove-Item Env:ADMIN_PASSWORD
```

Repita o comando para adicionar outros usuários. Para senhas iniciais abaixo de 12 caracteres, o script só permite o provisionamento quando `ALLOW_WEAK_ADMIN_PASSWORD=true` estiver definido explicitamente; prefira sempre senhas longas e exclusivas. A senha é armazenada somente como hash bcrypt. Não adicione credenciais reais ao projeto nem compartilhe a senha por canais inseguros. A recuperação automática não está integrada.

Para redefinir uma conta existente, configure `ADMIN_USERNAME` e `ADMIN_PASSWORD` como acima, defina temporariamente `RESET_ADMIN_PASSWORD=true` e execute `npm run create-admin`. Remova as três variáveis ao terminar.

## Dados MongoDB

- `products`: produtos, referência à categoria, nome da categoria para leitura do catálogo, preço opcional, estado, selos e referência GridFS da foto.
- `categories`: nome e ordem de exibição.
- `sitesettings`: documento único `key: "site"` com apresentação, imagens, contatos, redes e endereço.
- `admins`: nome de usuário único, papel administrativo e hash de senha; criação somente pelo script.
- `sessions`: sessões administrativas com expiração mantidas por `connect-mongo`.
- `siteImages.files` e `siteImages.chunks`: imagens binárias PNG, JPEG ou WebP no GridFS.

O servidor valida os campos antes de gravar; os esquemas Mongoose também aplicam validações e índices úteis. As operações de escrita exigem sessão administrativa e token CSRF. A API pública só lê configurações, categorias e produtos ativos. O upload é limitado a 5 MB e o servidor confirma a assinatura binária do formato; SVG não é aceito.
O limitador de tentativas de login usa memória local do processo; em hospedagem com várias instâncias, configure também o limitador equivalente no proxy/gateway.

## Painel

Em `/admin/`, entre com o nome de usuário e senha provisionados. O painel permite:

- Criar, editar, ativar, desativar e excluir produtos; definir categoria, preço e selos.
- Pesquisar e filtrar produtos por texto, categoria e estado.
- Enviar e pré-visualizar fotos de produto, hero e seção institucional.
- Criar, ordenar, editar e excluir categorias (a exclusão é impedida se ainda houver produtos associados).
- Alterar textos da página, WhatsApp, telefone, endereço, horários, mapa e redes sociais.
- O perfil público do Instagram da loja aparece no rodapé e na área de contato; o endereço pode ser ajustado no painel.
- **Preços**: edite direto na tabela de Produtos (campo de preço + "Salvar").
- **Pedidos**: digite o código do cliente (`HB-XXXX-XXXX`), confira itens/total e marque como entregue ou cancele.
- **Relatórios**: receita (pedidos entregues), nº de pedidos, ticket médio, pendentes, pedidos por dia, mais vendidos e receita por categoria, por período.

## Loja virtual

O site tem botões flutuantes de WhatsApp, Instagram e carrinho. O cliente adiciona produtos com preço, ajusta quantidades e clica em "Finalizar no WhatsApp": o servidor grava o pedido com os preços atuais do banco, gera um código único e abre o WhatsApp da loja com itens, total e código. Produtos sem preço não podem ser comprados (apenas "Consultar"). Pedidos ficam na coleção `orders` do MongoDB.

Se o IP de internet mudar (ex.: VPN), libere o novo IP em Atlas → Network Access, senão a conexão com o banco falha.

As fotos enviadas substituem as antigas somente depois de a gravação dos dados ser confirmada. Imagens armazenadas no GridFS não dependem do computador do proprietário.
A página usa ilustrações neutras de marca enquanto não há fotos enviadas. Substitua-as por imagens reais da loja pelo painel antes da publicação comercial. Os três produtos encontrados no JavaScript antigo eram exemplos fixos, não registros persistentes, por isso não são inseridos automaticamente como produtos reais.

## Publicação e configuração externa pendente

1. Provisionar MongoDB e definir `MONGODB_URI` com credenciais limitadas ao banco da aplicação.
2. Definir `SESSION_SECRET`, `SITE_ORIGIN` e `NODE_ENV=production`.
3. Executar `npm run create-admin` para cada conta administrativa no ambiente configurado.
4. Hospedar Node.js atrás de HTTPS e manter o processo/instância MongoDB disponível.
5. O GridFS guarda as imagens no MongoDB; inclua backup e retenção do banco na operação de produção.
6. Completar no painel os dados reais da loja e substituir as fotos demonstrativas da apresentação. Endereço e horários não estavam presentes no projeto recebido e, portanto, começam sem valor específico.

Não há chave, URI de banco ou serviço externo embutido no código. A integração MongoDB só pode ser considerada operacional após a configuração dessas etapas e a execução dos fluxos com uma instância real.

## Testes

```powershell
npm test
node --check server.js
node --check Js/app.js
node --check admin/admin.js
```

Os testes automatizados locais cobrem validações de formato e entrada. Testes de login, persistência, permissões no banco e upload completo precisam de MongoDB configurado; verifique-os antes da publicação em produção.
