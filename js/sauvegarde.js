/* ===========================================================
   Sauvegarde, restauration, fusion PC / téléphone, import des
   fichiers de cartes.

   Point important sur la fusion : on n'échange pas "l'état des
   cartes" mais le JOURNAL des révisions. Deux journaux s'additionnent
   sans conflit possible (une révision faite dans le bus le mardi et
   une autre sur le PC le mercredi sont deux lignes différentes).
   Après fusion, on rejoue les journaux et tout retombe en ordre.
   =========================================================== */

const Sauvegarde = {

  FORMAT: 'revisions-sauvegarde-v1',

  // ---------- Export ----------

  async construireExport() {
    const reglages = await Donnees.reglages();
    return {
      format: this.FORMAT,
      exporteLe: new Date().toISOString(),
      appareil: reglages.nomAppareil,
      paquets: await Donnees.tous('paquets'),
      cartes: await Donnees.tous('cartes'),
      revisions: await Donnees.tous('revisions'),
      reglages: reglages
    };
  },

  async exporterFichier() {
    const donnees = await this.construireExport();
    const jour = Planification.jourAujourdhui();
    const nom = 'sauvegarde-' + donnees.appareil.replace(/[^a-zA-Z0-9]/g, '') + '-' + jour + '.json';
    this.telecharger(nom, JSON.stringify(donnees, null, 1));
    await Donnees.majReglages({ derniereSauvegarde: new Date().toISOString() });
    return nom;
  },

  telecharger(nomFichier, texte) {
    const fichier = new Blob([texte], { type: 'application/json' });
    const lien = document.createElement('a');
    lien.href = URL.createObjectURL(fichier);
    lien.download = nomFichier;
    document.body.appendChild(lien);
    lien.click();
    document.body.removeChild(lien);
    setTimeout(function () { URL.revokeObjectURL(lien.href); }, 1000);
  },

  // ---------- Fusion d'une sauvegarde ----------

  async fusionner(donnees) {
    if (!donnees || donnees.format !== this.FORMAT) {
      throw new Error("Ce fichier n'est pas une sauvegarde de l'application.");
    }
    const reglages = await Donnees.reglages();
    const rapport = { paquets: 0, cartes: 0, revisions: 0, recalculees: 0 };

    // 1. Paquets : on garde la version modifiée le plus récemment.
    const paquetsLocaux = {};
    (await Donnees.tous('paquets')).forEach(function (p) { paquetsLocaux[p.id] = p; });
    const paquetsAEcrire = [];
    (donnees.paquets || []).forEach(function (paquet) {
      const local = paquetsLocaux[paquet.id];
      if (!local || (paquet.modifieLe || '') > (local.modifieLe || '')) {
        paquetsAEcrire.push(paquet);
        paquetsLocaux[paquet.id] = paquet;
        rapport.paquets++;
      }
    });
    await Donnees.ecrirePlusieurs('paquets', paquetsAEcrire);

    // 2. Cartes : même règle.
    const cartesLocales = {};
    (await Donnees.tous('cartes')).forEach(function (c) { cartesLocales[c.id] = c; });
    const cartesAEcrire = [];
    (donnees.cartes || []).forEach(function (carte) {
      const locale = cartesLocales[carte.id];
      if (!locale || (carte.modifieLe || '') > (locale.modifieLe || '')) {
        cartesAEcrire.push(carte);
        cartesLocales[carte.id] = carte;
        rapport.cartes++;
      }
    });
    await Donnees.ecrirePlusieurs('cartes', cartesAEcrire);

    // 3. Révisions : on ajoute simplement celles qu'on n'a pas.
    const connues = {};
    (await Donnees.tous('revisions')).forEach(function (r) { connues[r.id] = true; });
    const revisionsAEcrire = [];
    const cartesATraiter = {};
    (donnees.revisions || []).forEach(function (revision) {
      if (!connues[revision.id]) {
        revisionsAEcrire.push(revision);
        cartesATraiter[revision.carteId] = true;
        rapport.revisions++;
      }
    });
    await Donnees.ecrirePlusieurs('revisions', revisionsAEcrire);

    // 4. On rejoue le journal des cartes concernées.
    const identifiants = Object.keys(cartesATraiter);
    for (let i = 0; i < identifiants.length; i++) {
      const carte = cartesLocales[identifiants[i]];
      if (!carte) continue;
      await Planification.rafraichirCarte(carte, paquetsLocaux[carte.paquetId], reglages);
      rapport.recalculees++;
    }
    return rapport;
  },

  // ---------- Import d'un fichier de cartes ----------

  /* Format attendu (voir FORMAT-DES-CARTES.md) :
     { "format": "cartes-v1",
       "paquet": { "nom": "...", "matiere": "...", "echeance": "2026-10-03" },
       "cartes": [ { "type": "rappel", "question": "...", "elementsCles": [...],
                     "reponse": "...", "exemples": [...], "source": "photo 2" } ] } */
  async importerCartes(donnees) {
    if (!donnees || donnees.format !== 'cartes-v1' || !Array.isArray(donnees.cartes)) {
      throw new Error("Ce fichier n'est pas un fichier de cartes (format \"cartes-v1\" attendu).");
    }
    const maintenant = new Date().toISOString();

    // On retrouve le paquet par son nom, sinon on le crée.
    const paquets = await Donnees.tous('paquets');
    const nomVoulu = (donnees.paquet && donnees.paquet.nom) ? donnees.paquet.nom : 'Sans nom';
    let paquet = paquets.find(function (p) { return p.nom === nomVoulu; });
    let paquetCree = false;
    if (!paquet) {
      paquet = {
        id: Donnees.nouvelId(),
        nom: nomVoulu,
        matiere: (donnees.paquet && donnees.paquet.matiere) || '',
        echeance: (donnees.paquet && donnees.paquet.echeance) || null,
        retentionCible: null,
        creeLe: maintenant,
        modifieLe: maintenant
      };
      await Donnees.ecrire('paquets', paquet);
      paquetCree = true;
    } else if (donnees.paquet && donnees.paquet.echeance && !paquet.echeance) {
      paquet.echeance = donnees.paquet.echeance;
      paquet.modifieLe = maintenant;
      await Donnees.ecrire('paquets', paquet);
    }

    // On évite les doublons si le même fichier est importé deux fois.
    const existantes = (await Donnees.tous('cartes')).filter(function (c) { return c.paquetId === paquet.id; });
    const questionsConnues = {};
    existantes.forEach(function (c) { questionsConnues[c.question.trim()] = true; });

    const nouvelles = [];
    let ignorees = 0;
    donnees.cartes.forEach(function (source) {
      const question = String(source.question || '').trim();
      if (!question) return;
      if (questionsConnues[question]) { ignorees++; return; }
      questionsConnues[question] = true;
      nouvelles.push({
        id: Donnees.nouvelId(),
        paquetId: paquet.id,
        type: source.type === 'explique' ? 'explique' : 'rappel',
        question: question,
        elementsCles: Array.isArray(source.elementsCles) ? source.elementsCles.filter(Boolean) : [],
        reponse: String(source.reponse || ''),
        exemples: Array.isArray(source.exemples) ? source.exemples.filter(Boolean) : [],
        maFormulation: '',
        surPapier: !!source.surPapier,
        source: source.source || '',
        statut: 'brouillon',          // à valider avant d'entrer en révision
        etat: null,
        creeLe: maintenant,
        modifieLe: maintenant
      });
    });
    await Donnees.ecrirePlusieurs('cartes', nouvelles);
    return { paquet: paquet, ajoutees: nouvelles.length, ignorees: ignorees, paquetCree: paquetCree };
  },

  // ---------- Lecture d'un fichier choisi par l'utilisateur ----------

  lireFichier(fichier) {
    return new Promise(function (resoudre, rejeter) {
      const lecteur = new FileReader();
      lecteur.onload = function () {
        try { resoudre(JSON.parse(lecteur.result)); }
        catch (erreur) { rejeter(new Error('Fichier illisible : ' + erreur.message)); }
      };
      lecteur.onerror = function () { rejeter(lecteur.error); };
      lecteur.readAsText(fichier);
    });
  }
};
