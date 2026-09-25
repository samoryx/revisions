/* ===========================================================
   Planification : à partir du JOURNAL des révisions d'une carte,
   on recalcule son état et sa prochaine date.

   Pourquoi recalculer au lieu de simplement mettre à jour ?
   Parce que c'est ce qui rend la fusion PC / téléphone fiable :
   on additionne les deux journaux, on rejoue tout dans l'ordre,
   et on retombe forcément sur le même résultat des deux côtés.

   Règles ajoutées par-dessus FSRS :
   - chaque paquet est dans une SECTION (Comprendre, Apprendre,
     Entretenir) qui décide quelles cartes sont en jeu, à quel
     rythme, et dans quel ordre elles passent ;
   - la dernière révision avant une échéance tombe la VEILLE ;
   - petit décalage aléatoire pour éviter que 40 cartes créées le
     même jour reviennent toutes ensemble pour toujours ;
   - une carte est "acquise" après 3 rappels réussis des jours
     différents (critère du réapprentissage successif), pas après un seul.
   =========================================================== */

const Planification = {

  REUSSITES_POUR_ACQUISE: 3,

  // ---------- Les trois sections ----------
  //
  // Ce sont les étapes de la vie d'un chapitre :
  // Comprendre (cours en cours) → Apprendre (contrôle en vue)
  // → Entretenir (contrôle passé, à garder) → Apprendre (bac) → …
  //
  // "priorite" : ordre de passage en session (1 passe en premier).
  // La priorité 1 est réservée aux paquets urgents.

  SECTIONS: {
    comprendre: {
      nom: 'Comprendre',
      priorite: 3,
      description: 'Chapitre en cours. Seules les cartes de compréhension et de méthode sont en jeu ; les détails à apprendre par cœur attendent la section Apprendre.'
    },
    apprendre: {
      nom: 'Apprendre',
      priorite: 2,
      description: 'Contrôle en vue. Toutes les cartes sont en jeu. Les nouvelles arrivent assez tôt pour être espacées, et la dernière révision tombe la veille du contrôle.'
    },
    entretenir: {
      nom: 'Entretenir',
      priorite: 4,
      description: 'Contrôle passé, à garder. Seules les cartes essentielles restent en jeu, avec des intervalles plus longs. Elles passent en dernier : un retard de quelques jours leur coûte très peu.'
    }
  },

  JOURS_URGENCE: 7,                  // "urgent" = contrôle dans 7 jours ou moins
  RETENTION_ENTRETIEN_DEFAUT: 0.85,
  INTERVALLE_MAX_ENTRETIEN: 180,
  JOURS_RETOUR_APPRENDRE: 30,        // suggérer Apprendre 30 jours avant une échéance

  // Section d'un paquet. Les paquets créés avant l'existence des sections
  // en reçoivent une d'après leur échéance.
  sectionDe: function (paquet) {
    if (paquet && this.SECTIONS[paquet.section]) return paquet.section;
    return (paquet && paquet.echeance) ? 'apprendre' : 'comprendre';
  },

  /* Une carte participe-t-elle aux révisions dans la section actuelle ?
     Un marquage absent compte comme "oui" : on ne cache jamais une carte
     par accident. */
  carteEnJeu: function (carte, paquet) {
    if (carte.statut !== 'active') return false;
    const section = this.sectionDe(paquet);
    if (section === 'comprendre') return carte.comprendre !== false;
    if (section === 'entretenir') return carte.essentiel !== false;
    return true;
  },

  retentionPour: function (paquet, reglages) {
    if (this.sectionDe(paquet) === 'entretenir') {
      return paquet.retentionEntretien || this.RETENTION_ENTRETIEN_DEFAUT;
    }
    return (paquet && paquet.retentionCible) || reglages.retentionCible;
  },

  intervalleMaxPour: function (paquet, reglages) {
    if (this.sectionDe(paquet) === 'entretenir') {
      return Math.max(reglages.intervalleMaxJours, this.INTERVALLE_MAX_ENTRETIEN);
    }
    return reglages.intervalleMaxJours;
  },

  joursAvantEcheance: function (paquet, jour) {
    if (!paquet || !paquet.echeance) return null;
    return this.differenceEnJours(jour, paquet.echeance);
  },

  estUrgent: function (paquet, jour) {
    if (!paquet || paquet.archive || this.sectionDe(paquet) !== 'apprendre') return false;
    const restant = this.joursAvantEcheance(paquet, jour);
    return restant !== null && restant >= 0 && restant <= this.JOURS_URGENCE;
  },

  priorite: function (paquet, jour) {
    if (this.estUrgent(paquet, jour)) return 1;
    return this.SECTIONS[this.sectionDe(paquet)].priorite;
  },

  /* Changement de section à proposer (c'est toujours toi qui décides).
     Renvoie null s'il n'y a rien à proposer, ou si tu as déjà ignoré
     cette proposition. */
  suggestionPour: function (paquet, jour) {
    if (!paquet || paquet.archive) return null;
    const section = this.sectionDe(paquet);
    const restant = this.joursAvantEcheance(paquet, jour);
    if (restant === null) return null;

    let suggestion = null;
    if (section === 'comprendre' && restant >= 0) {
      suggestion = { type: 'vers-apprendre', restant: restant };
    } else if (section === 'apprendre' && restant < 0) {
      suggestion = { type: 'apres-controle', restant: restant };
    } else if (section === 'entretenir' && restant >= 0 && restant <= this.JOURS_RETOUR_APPRENDRE) {
      suggestion = { type: 'retour-apprendre', restant: restant };
    }
    if (!suggestion) return null;
    suggestion.cle = suggestion.type + '@' + paquet.echeance;
    return paquet.suggestionIgnoree === suggestion.cle ? null : suggestion;
  },

  // ---------- Outils de date. Tout est stocké en "AAAA-MM-JJ". ----------

  jourAujourdhui: function () {
    const maintenant = new Date();
    // On construit la date locale à la main : toISOString() donnerait
    // l'heure UTC, ce qui décale d'un jour en soirée.
    const mois = String(maintenant.getMonth() + 1).padStart(2, '0');
    const jour = String(maintenant.getDate()).padStart(2, '0');
    return maintenant.getFullYear() + '-' + mois + '-' + jour;
  },

  ajouterJours: function (jour, nombre) {
    const date = new Date(jour + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + nombre);
    return date.toISOString().slice(0, 10);
  },

  differenceEnJours: function (jourDebut, jourFin) {
    const a = Date.parse(jourDebut + 'T00:00:00Z');
    const b = Date.parse(jourFin + 'T00:00:00Z');
    return Math.round((b - a) / 86400000);
  },

  jourLisible: function (jour) {
    const date = new Date(jour + 'T00:00:00Z');
    return date.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  },

  /* Décalage aléatoire de ±5 % sur les intervalles d'au moins 3 jours.
     Le hasard est tiré de l'identifiant de la révision : il est donc
     toujours le même si on rejoue le journal (sinon le PC et le
     téléphone calculeraient des dates différentes). */
  appliquerDecalage: function (jours, graine) {
    if (jours < 3) return jours;
    let nombre = 0;
    for (let i = 0; i < graine.length; i++) {
      nombre = (nombre * 31 + graine.charCodeAt(i)) % 100000;
    }
    const fraction = nombre / 100000;            // entre 0 et 1
    const variation = (fraction - 0.5) * 0.1;    // entre -5 % et +5 %
    return Math.max(1, Math.round(jours * (1 + variation)));
  },

  /* Rejoue tout le journal d'une carte et renvoie son PARCOURS : une étape
     par révision qui a compté, avec l'intervalle qu'elle a produit.
     C'est la source unique — l'état de la carte en est simplement la
     dernière étape, et l'affichage « 46 j → échec → 3 j » la parcourt. */
  parcours: function (revisions, paquet, reglages) {
    const etapes = [];
    let memoire = null;          // { stabilite, difficulte }
    let dernierJour = null;
    let echecs = 0;
    let reussitesDeSuite = 0;

    for (let i = 0; i < revisions.length; i++) {
      const revision = revisions[i];

      // Les répétitions à l'intérieur d'une même session ne replanifient rien :
      // elles servent à finir la session sur un rappel réussi, pas à décaler la carte.
      if (revision.planifie === false) continue;

      const jour = revision.date.slice(0, 10);
      const joursEcoules = dernierJour ? this.differenceEnJours(dernierJour, jour) : 0;

      // Deuxième passage planifié le même jour : on ignore, FSRS attend
      // au moins un jour entre deux mesures de mémoire.
      if (memoire && joursEcoules === 0) continue;

      memoire = FSRS.prochainEtat(memoire, joursEcoules, revision.note);

      if (revision.note === 1) {
        echecs++;
        reussitesDeSuite = 0;
      } else {
        reussitesDeSuite++;
      }

      const intervalle = this.calculerIntervalle(memoire.stabilite, jour, paquet, reglages, revision.id);
      etapes.push({
        jour: jour,
        note: revision.note,
        joursEcoules: joursEcoules,
        intervalle: intervalle,
        dueLe: this.ajouterJours(jour, intervalle),
        stabilite: memoire.stabilite,
        difficulte: memoire.difficulte,
        echecs: echecs,
        reussitesDeSuite: reussitesDeSuite
      });
      dernierJour = jour;
    }
    return etapes;
  },

  /* L'état d'une carte = la dernière étape de son parcours. */
  etatDepuisJournal: function (revisions, paquet, reglages) {
    const etapes = this.parcours(revisions, paquet, reglages);
    if (etapes.length === 0) return null;   // carte jamais révisée
    const derniere = etapes[etapes.length - 1];
    return {
      stabilite: derniere.stabilite,
      difficulte: derniere.difficulte,
      dueLe: derniere.dueLe,
      dernierJour: derniere.jour,
      dernierIntervalle: derniere.intervalle,
      echecs: derniere.echecs,
      reussitesDeSuite: derniere.reussitesDeSuite,
      nbRevisions: etapes.length,
      acquise: derniere.reussitesDeSuite >= this.REUSSITES_POUR_ACQUISE
    };
  },

  /* Nombre de jours avant la prochaine révision, plafonds compris. */
  calculerIntervalle: function (stabilite, jour, paquet, reglages, graine) {
    let jours = FSRS.intervalle(stabilite, this.retentionPour(paquet, reglages));
    jours = Math.max(1, Math.round(jours));
    // graine absente = simple aperçu affiché sur un bouton : pas de décalage,
    // sinon le nombre annoncé ne serait pas celui qui sera enregistré.
    if (graine) jours = this.appliquerDecalage(jours, graine);
    // Le plafond s'applique APRÈS le décalage, pour ne jamais être dépassé.
    jours = Math.min(jours, this.intervalleMaxPour(paquet, reglages));

    // Échéance : on ne saute jamais par-dessus, et la dernière révision
    // tombe la VEILLE (le jour même serait trop tard pour un contrôle à 8 h).
    // Une révision faite la veille n'est pas ramenée au jour J : inutile.
    // Une fois l'échéance passée, ce plafond ne s'applique plus.
    if (paquet && paquet.echeance) {
      const restant = this.differenceEnJours(jour, paquet.echeance);
      if (restant >= 2) jours = Math.min(jours, restant - 1);
    }
    return Math.max(1, jours);
  },

  estDue: function (carte, jour) {
    if (!carte.etat) return false;              // jamais vue = "nouvelle", pas "due"
    return carte.etat.dueLe <= jour;
  },

  estSangsue: function (carte, reglages) {
    return !!(carte.etat && carte.etat.echecs >= reglages.seuilSangsue);
  },

  // Ordre d'introduction des nouvelles cartes : celui du cours.
  ordreDuCours: function (a, b) {
    if ((a.creeLe || '') !== (b.creeLe || '')) return (a.creeLe || '') < (b.creeLe || '') ? -1 : 1;
    return (a.ordre || 0) - (b.ordre || 0);
  },

  /* Les cartes à passer aujourd'hui : les cartes dues + les nouvelles
     autorisées. L'accueil ET la session utilisent cette même fonction,
     pour annoncer toujours la même chose.

     Nouvelles cartes :
     - paquet en Apprendre avec une date : quota calculé pour que toutes
       ses cartes soient vues au plus tard 2 jours avant le contrôle
       (sinon elles n'auraient pas le temps d'être espacées) ;
     - tous les autres : se partagent la limite quotidienne des réglages,
       par ordre de priorité. */
  selectionDuJour: function (cartes, paquets, reglages, jour, paquetsChoisis) {
    const parId = {};
    paquets.forEach(p => { parId[p.id] = p; });

    const enJeu = {};
    paquets.forEach(p => { if (!p.archive) enJeu[p.id] = []; });
    cartes.forEach(c => {
      const p = parId[c.paquetId];
      if (p && !p.archive && this.carteEnJeu(c, p)) enJeu[p.id].push(c);
    });

    const choisi = p => !paquetsChoisis || paquetsChoisis.indexOf(p.id) !== -1;
    const dues = [];
    const nouvelles = [];
    const reserve = [];                 // paquets qui puisent dans la limite quotidienne
    let introduitesSurLaLimite = 0;

    paquets.forEach(p => {
      if (p.archive) return;
      const liste = enJeu[p.id];
      const introduites = liste.filter(c => c.etat && c.etat.nbRevisions === 1 && c.etat.dernierJour === jour).length;
      const jamaisVues = liste.filter(c => !c.etat).sort(this.ordreDuCours);
      const restant = this.joursAvantEcheance(p, jour);
      const quotaPropre = this.sectionDe(p) === 'apprendre' && restant !== null && restant >= 1;

      if (quotaPropre) {
        if (choisi(p)) {
          const joursDisponibles = Math.max(1, restant - 2);
          const quota = Math.ceil((jamaisVues.length + introduites) / joursDisponibles) - introduites;
          nouvelles.push(...jamaisVues.slice(0, Math.max(0, quota)));
        }
      } else {
        introduitesSurLaLimite += introduites;
        if (choisi(p)) reserve.push({ paquet: p, jamaisVues: jamaisVues });
      }
      if (choisi(p)) dues.push(...liste.filter(c => this.estDue(c, jour)));
    });

    // Partage de la limite quotidienne : par priorité d'abord ; entre paquets
    // de même priorité, à tour de rôle (une carte chacun, puis on recommence),
    // pour ne pas tout donner au premier paquet de la liste.
    let places = Math.max(0, reglages.nouvellesParJour - introduitesSurLaLimite);
    const niveaux = {};
    reserve.forEach(r => {
      const niveau = this.priorite(r.paquet, jour);
      if (!niveaux[niveau]) niveaux[niveau] = [];
      niveaux[niveau].push(r.jamaisVues.slice());
    });
    Object.keys(niveaux).map(Number).sort((a, b) => a - b).forEach(niveau => {
      const files = niveaux[niveau];
      while (places > 0 && files.some(f => f.length > 0)) {
        files.forEach(f => {
          if (places > 0 && f.length > 0) { nouvelles.push(f.shift()); places--; }
        });
      }
    });

    return { dues: dues, nouvelles: nouvelles, total: dues.length + nouvelles.length };
  },

  /* Recalcule et enregistre l'état d'une carte à partir du journal. */
  rafraichirCarte: async function (carte, paquet, reglages) {
    const revisions = await Donnees.revisionsDeLaCarte(carte.id);
    carte.etat = this.etatDepuisJournal(revisions, paquet, reglages);
    await Donnees.ecrire('cartes', carte);
    return carte;
  },

  /* Recalcule toutes les cartes d'un paquet (après un changement de
     section, de rétention ou d'échéance). */
  rafraichirPaquet: async function (paquet, reglages) {
    const cartes = (await Donnees.tous('cartes')).filter(c => c.paquetId === paquet.id && c.etat);
    for (const carte of cartes) {
      await this.rafraichirCarte(carte, paquet, reglages);
    }
  }
};
