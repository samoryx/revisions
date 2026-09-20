/* ===========================================================
   Synchronisation automatique entre le PC et le téléphone.

   Comment ça marche :
   1. L'app fabrique la même sauvegarde que le bouton « Exporter ».
   2. Elle la compresse, puis la CHIFFRE avec ta phrase de passe.
      Ce qui sort est illisible sans cette phrase.
   3. Elle dépose le résultat dans un fichier d'un dépôt GitHub PRIVÉ,
      qui t'appartient.
   4. L'autre appareil le récupère, le déchiffre, et le fusionne avec
      ce qu'il a déjà (les journaux de révisions s'additionnent).

   Ce que GitHub voit : un fichier de caractères incompréhensibles.
   Ce que personne d'autre ne voit : le dépôt est privé.

   Les identifiants (dépôt, jeton, phrase de passe) restent dans le
   navigateur de CET appareil, dans un stockage séparé : ils ne
   partent donc jamais dans une sauvegarde ni dans la synchronisation.
   =========================================================== */

const Synchro = {

  CLE_LOCALE: 'revisions-synchro',
  CHEMIN_FICHIER: 'synchronisation.json',
  ITERATIONS: 200000,        // pour transformer la phrase de passe en clé
  TAILLE_ALERTE: 900000,     // au-delà, l'API GitHub devient capricieuse
  enCours: false,

  // ---------- Réglages, stockés sur cet appareil seulement ----------

  reglages() {
    try { return JSON.parse(localStorage.getItem(this.CLE_LOCALE)) || {}; }
    catch (erreur) { return {}; }
  },

  enregistrerReglages(modifications) {
    const reglages = Object.assign(this.reglages(), modifications);
    localStorage.setItem(this.CLE_LOCALE, JSON.stringify(reglages));
    return reglages;
  },

  oublier() { localStorage.removeItem(this.CLE_LOCALE); },

  estConfigure() {
    const r = this.reglages();
    return !!(r.depot && r.jeton && r.phrase);
  },

  // ---------- Outils : compression et base64 ----------

  async compresser(texte) {
    const flux = new Blob([texte]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(flux).arrayBuffer());
  },

  async decompresser(octets) {
    const flux = new Blob([octets]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(flux).text();
  },

  enBase64(octets) {
    let texte = '';
    const morceau = 0x8000;   // par tranches, sinon la pile déborde sur les gros fichiers
    for (let i = 0; i < octets.length; i += morceau) {
      texte += String.fromCharCode.apply(null, octets.subarray(i, i + morceau));
    }
    return btoa(texte);
  },

  depuisBase64(base64) {
    const texte = atob(base64);
    const octets = new Uint8Array(texte.length);
    for (let i = 0; i < texte.length; i++) octets[i] = texte.charCodeAt(i);
    return octets;
  },

  // ---------- Chiffrement ----------

  /* Transforme la phrase de passe en clé de chiffrement. Le "sel" est un
     tirage aléatoire enregistré avec le fichier : il empêche d'attaquer
     plusieurs fichiers d'un coup. Les 200 000 tours rendent les essais
     de mots de passe très lents. */
  async cleDepuisPhrase(phrase, sel) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(phrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: sel, iterations: this.ITERATIONS, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  },

  async chiffrer(texte, phrase) {
    const sel = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cle = await this.cleDepuisPhrase(phrase, sel);
    const compresse = await this.compresser(texte);
    const chiffre = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, cle, compresse));
    return {
      format: 'revisions-synchro-v1',
      chiffreLe: new Date().toISOString(),
      sel: this.enBase64(sel),
      iv: this.enBase64(iv),
      donnees: this.enBase64(chiffre)
    };
  },

  async dechiffrer(enveloppe, phrase) {
    if (!enveloppe || enveloppe.format !== 'revisions-synchro-v1') {
      throw new Error('Le fichier de synchronisation n\'a pas le bon format.');
    }
    const cle = await this.cleDepuisPhrase(phrase, this.depuisBase64(enveloppe.sel));
    let compresse;
    try {
      compresse = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: this.depuisBase64(enveloppe.iv) }, cle, this.depuisBase64(enveloppe.donnees)));
    } catch (erreur) {
      // AES-GCM refuse de déchiffrer si la clé est fausse : c'est voulu.
      throw new Error('La phrase de passe ne correspond pas à celle de l\'autre appareil.');
    }
    return JSON.parse(await this.decompresser(compresse));
  },

  // ---------- Dialogue avec GitHub ----------

  async appel(chemin, options) {
    const reglages = this.reglages();
    let reponse;
    try {
      reponse = await fetch('https://api.github.com' + chemin, Object.assign({
        cache: 'no-store',      // toujours la version à jour, jamais celle du cache
        headers: {
          'Authorization': 'Bearer ' + reglages.jeton,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }, options || {}));
    } catch (erreur) {
      throw new Error('Pas de connexion : la synchronisation se fera plus tard.');
    }
    if (reponse.status === 401) throw new Error('Jeton refusé : il est peut-être expiré ou mal copié.');
    if (reponse.status === 403) throw new Error('Accès refusé : le jeton doit avoir la permission « Contents : Read and write » sur ce dépôt.');
    return reponse;
  },

  async lireDistant() {
    const reglages = this.reglages();
    const reponse = await this.appel('/repos/' + reglages.depot + '/contents/' + this.CHEMIN_FICHIER);
    if (reponse.status === 404) {
      /* GitHub répond « pas trouvé » dans deux cas très différents : le fichier
         n'existe pas encore (normal à la première synchronisation), ou le dépôt
         est inaccessible. On tranche en demandant le dépôt lui-même. */
      const verification = await this.appel('/repos/' + reglages.depot);
      if (verification.status === 404) {
        throw new Error('Dépôt introuvable : vérifie le nom (utilisateur/dépôt), et que le jeton donne accès à CE dépôt.');
      }
      if (!verification.ok) throw new Error('Dépôt inaccessible (code ' + verification.status + ').');
      return { enveloppe: null, sha: null };   // première synchronisation : le fichier va être créé
    }
    if (!reponse.ok) throw new Error('Lecture impossible (code ' + reponse.status + ').');
    const fichier = await reponse.json();
    const texte = new TextDecoder().decode(this.depuisBase64(fichier.content.replace(/\n/g, '')));
    return { enveloppe: JSON.parse(texte), sha: fichier.sha };
  },

  /* Renvoie true si l'écriture a réussi, false si l'autre appareil a écrit
     entre-temps (il faut alors refusionner avant de réessayer). */
  async ecrireDistant(enveloppe, sha) {
    const reglages = this.reglages();
    const texte = JSON.stringify(enveloppe);
    const corps = {
      message: 'Synchronisation depuis ' + (reglages.nomAppareil || 'un appareil') + ' — ' + new Date().toISOString(),
      content: this.enBase64(new TextEncoder().encode(texte))
    };
    if (sha) corps.sha = sha;
    const reponse = await this.appel('/repos/' + reglages.depot + '/contents/' + this.CHEMIN_FICHIER, {
      method: 'PUT',
      body: JSON.stringify(corps)
    });
    if (reponse.status === 409 || reponse.status === 422) return false;   // conflit : on refera un tour
    if (!reponse.ok) throw new Error('Écriture impossible (code ' + reponse.status + ').');
    return true;
  },

  /* Teste la configuration point par point et dit ce qui ne va pas.
     Trois questions : le jeton est-il valide ? donne-t-il accès à ce dépôt ?
     a-t-il le droit d'y écrire ? */
  async diagnostic() {
    const reglages = this.reglages();
    const lignes = [];
    if (!reglages.depot || !reglages.jeton || !reglages.phrase) {
      return ['Il manque le dépôt, le jeton ou la phrase de passe.'];
    }

    let compte = null;
    try {
      const reponse = await this.appel('/user');
      if (!reponse.ok) return ['Le jeton est refusé par GitHub (code ' + reponse.status + ').'];
      compte = await reponse.json();
      lignes.push('✅ Jeton valide, il appartient au compte « ' + compte.login + ' ».');
    } catch (erreur) {
      return ['❌ ' + erreur.message];
    }

    const proprietaire = reglages.depot.split('/')[0];
    if (compte && proprietaire.toLowerCase() !== compte.login.toLowerCase()) {
      lignes.push('⚠️ Le dépôt commence par « ' + proprietaire + ' » alors que le jeton appartient à « ' + compte.login + ' ». Le début doit être ton nom de compte.');
    }

    try {
      const reponse = await this.appel('/repos/' + reglages.depot);
      if (reponse.status === 404) {
        lignes.push('❌ Ce jeton ne voit pas le dépôt « ' + reglages.depot + ' ».');
        lignes.push('Deux causes possibles : le nom du dépôt n\'est pas exactement celui-là, ou le jeton a été créé avec « Public repositories » au lieu de « Only select repositories » → ' + (reglages.depot.split('/')[1] || '') + '.');
        return lignes;
      }
      if (!reponse.ok) { lignes.push('❌ Dépôt inaccessible (code ' + reponse.status + ').'); return lignes; }
      const depot = await reponse.json();
      lignes.push('✅ Dépôt trouvé : « ' + depot.full_name + ' »' + (depot.private ? ' (privé, c\'est bien)' : ' — attention, il est PUBLIC'));
      if (depot.permissions && depot.permissions.push === false) {
        lignes.push('❌ Le jeton peut lire mais pas écrire : mets la permission « Contents » sur « Read and write ».');
        return lignes;
      }
      lignes.push('✅ Droit d\'écriture accordé.');
    } catch (erreur) {
      lignes.push('❌ ' + erreur.message);
      return lignes;
    }
    lignes.push('Tout est en ordre : clique sur « Synchroniser maintenant ».');
    return lignes;
  },

  // ---------- La synchronisation elle-même ----------

  /* Un tour = lire le distant, le fusionner ici, renvoyer le tout.
     Si l'autre appareil a écrit pendant ce temps, on recommence : comme
     la fusion additionne les journaux, recommencer ne perd jamais rien. */
  async synchroniser() {
    if (this.enCours) return { etat: 'occupe' };
    if (!this.estConfigure()) return { etat: 'non-configure' };
    this.enCours = true;
    try {
      for (let essai = 0; essai < 3; essai++) {
        const distant = await this.lireDistant();
        let recu = { paquets: 0, cartes: 0, revisions: 0, recalculees: 0 };
        if (distant.enveloppe) {
          const sauvegarde = await this.dechiffrer(distant.enveloppe, this.reglages().phrase);
          recu = await Sauvegarde.fusionner(sauvegarde);
        }
        const local = await Sauvegarde.construireExport();
        const enveloppe = await this.chiffrer(JSON.stringify(local), this.reglages().phrase);
        const taille = JSON.stringify(enveloppe).length;
        if (await this.ecrireDistant(enveloppe, distant.sha)) {
          this.enregistrerReglages({ derniereSynchro: new Date().toISOString(), dernierMessage: null });
          return { etat: 'ok', recu: recu, taille: taille, alerteTaille: taille > this.TAILLE_ALERTE };
        }
      }
      throw new Error('L\'autre appareil écrit en même temps. Réessaie dans un instant.');
    } catch (erreur) {
      this.enregistrerReglages({ dernierMessage: erreur.message });
      return { etat: 'erreur', message: erreur.message };
    } finally {
      this.enCours = false;
    }
  },

  /* Version silencieuse, pour le lancement de l'app et la fin d'une session :
     elle ne dérange pas si l'appareil est hors ligne. */
  async synchroniserEnFond() {
    if (!this.estConfigure() || !navigator.onLine) return { etat: 'hors-ligne' };
    return this.synchroniser();
  },

  texteDerniereSynchro() {
    const reglages = this.reglages();
    if (!reglages.derniereSynchro) return 'jamais';
    const minutes = Math.round((Date.now() - Date.parse(reglages.derniereSynchro)) / 60000);
    if (minutes < 1) return 'à l\'instant';
    if (minutes < 60) return 'il y a ' + minutes + ' min';
    const heures = Math.round(minutes / 60);
    if (heures < 24) return 'il y a ' + heures + ' h';
    return 'le ' + new Date(reglages.derniereSynchro).toLocaleDateString('fr-FR');
  }
};
