# tenup-proxy

Proxy Node/Express vers l'API REST TenUp (FFT), déployé sur Railway.

- **URL de prod :** https://tenup-proxy-production.up.railway.app
- **Projet Railway :** `perceptive-education`
- **Auth :** variable `PROXY_API_KEY` (Railway). Le site la lit dans le secret Supabase
  `TENUP_PROXY_API_KEY` et l'URL dans `TENUP_PROXY_URL`. Ne jamais committer la clé.
- **Déploiements :** Railway les refuse de 2h à 14h, heure de Paris.

Vérification rapide (CLI Railway liée) :

```sh
KEY=$(railway variables --json | node -pe "JSON.parse(require('fs').readFileSync(0)).PROXY_API_KEY")
curl -s -H "x-api-key: $KEY" "https://tenup-proxy-production.up.railway.app/tournois?clubId=60318009"
```
