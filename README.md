# PoE2 Client Analytics

Projeto local para transformar o `client.txt` do Path of Exile 2 em um dashboard de campanhas.

## Website local

Abra `index.html` no navegador para usar a versao estilo landing/app. Ela roda o ETL no proprio browser:

1. Clique em `Escolher arquivo`.
2. Selecione seu `client.txt`.
3. Aguarde o processamento.
4. Use os filtros de versao, classe e liga.

Por seguranca, o navegador nao permite que a pagina leia `C:\...\client.txt` sozinha. O usuario precisa selecionar ou arrastar o arquivo.

## Como gerar

O modo CLI usa Node.js puro, sem pacotes externos. Nesta maquina o Node ja esta instalado.

Rode na raiz deste workspace:

```powershell
node .\poe2-client-analyzer.mjs
```

Ou:

```powershell
npm.cmd run analyze
```

No PowerShell, `npm run analyze` pode ser bloqueado pela policy de scripts por causa do `npm.ps1`; `npm.cmd run analyze` evita isso.

Por padrao ele le:

```text
C:\Program Files (x86)\Steam\steamapps\common\Path of Exile 2\logs\client.txt
```

E gera:

- `data/analysis.json`: dados estruturados.
- `dashboard.html`: dashboard autocontido, pronto para abrir no navegador.

Para usar outro arquivo:

```powershell
node .\poe2-client-analyzer.mjs --log "C:\caminho\para\client.txt"
```

## O que o dashboard mede

- Campanhas detectadas por entradas de area inicial `G1_1`.
- Versao Early Access por tag do client, como `4.1.x -> 0.1`, `4.2.x -> 0.2`, `4.3.x -> 0.3`, `4.4.x -> 0.4`.
- Liga por indicios de trade whisper, como `listed ... in Standard/Hardcore`.
- Duplicacao de uma campanha quando trade whispers dentro da mesma campanha apontam para mais de uma liga.
- Personagem e classe por mensagens de level-up.
- Tempo por ato/area usando eventos `Generating level ... area`.
- Mapas endgame feitos, contando apenas areas internas `Map*` e deduplicando reentradas pela mesma seed.
- Ranking de mapas endgame por nome legivel vindo de `[SCENE] Set Source`, como `Sacred Reservoir` e `The Jade Isles`.
- Ranking de mapas anomaly frequentados, contando visitas/reentradas por nome e incluindo as areas internas `MapUniqueReactor_*`.
- Tempo em hideout por areas com `Hideout`.
- AFK por eventos `AFK mode is now ON/OFF`.
- Tempo fora de foco como proxy para pause/alt-tab.
- Tempo estimado na passive tree ao redor de alocacoes/desalocacoes de passivas.
- Contagem bruta das passivas alocadas/desalocadas.

## Limites conhecidos

O `client.txt` nao registra tudo com precisao perfeita. Skill usada em combate, arma equipada e tela de passive tree aberta nao aparecem como eventos diretos consistentes. Por isso o projeto nao tenta classificar build/arma/skill por heuristica.

Tambem podem aparecer personagens de party em mensagens de level-up. O dashboard lista candidatos e escolhe o mais frequente na janela da campanha.

Liga privada so aparece quando algum texto do log entrega o nome, normalmente em whisper de trade. Quando nao houver esse sinal, o dashboard mostra `Indefinida`. Nomes de personagem como `Race`, `SSF` ou `HCSSF` nao sao usados para inferir liga.

## Datas de versao

Quando a tag do client nao aparece, o analisador usa janelas de data:

- `0.1` Early Access: 2024-12-06.
- `0.2` Dawn of the Hunt: 2025-04-04.
- `0.3` The Third Edict: 2025-08-29.
- `0.4` The Last of the Druids: 2025-12-12.
