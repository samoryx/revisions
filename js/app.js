/* ===========================================================
   L'interface : affichage des écrans et réactions aux clics.

   Fonctionnement : chaque écran est une fonction qui fabrique du
   HTML, l'installe dans <main>, puis branche ses boutons.
   =========================================================== */

const App = {

  ecran: 'accueil',
  contexte: {},
  pile: [],                 // pour le bouton retour
  phaseSession: null,       // 'question' | 'confiance' | 'verso' | 'fin'
  brouillonReponse: '',
  confianceChoisie: null,
  elementsCoches: [],
  interactionVerso: false,

  // ---------- Démarrage ----------

  async demarrer() {
    await Donnees.ouvrir();

    // Demande au navigateur de ne pas effacer les données automatiquement.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persisted().then(function (dejaProtege) {
        if (!dejaProtege) navigator.storage.persist();
      });
    }

    // Le "service worker" met l'app en cache pour qu'elle marche sans connexion.
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* sans importance en local */ });
    }

    document.querySelectorAll('#barre-bas .onglet').forEach(bouton => {
      bouton.addEventListener('click', () => this.aller(bouton.dataset.ecran, {}, true));
    });
    document.getElementById('bouton-retour').addEventListener('click', () => this.retour());

    await this.mettreANiveau();
    await this.aller('accueil', {}, true);

    // Synchronisation silencieuse au lancement : si l'appareil est hors ligne,
    // il ne se passe rien et les révisions marchent quand même.
    if (Synchro.estConfigure()) {
      Synchro.synchroniserEnFond().then(resultat => {
        if (resultat.etat === 'ok' && this.ecran === 'accueil') this.rendre();
      });
    }
  },

  /* Adapte les données créées par une version précédente de l'app.
     Ne s'exécute qu'une fois par appareil. */
  async mettreANiveau() {
    const reglages = await Donnees.reglages();
    if ((reglages.versionDonnees || 1) >= 2) return;
    // Version 2 : les sections. Chaque paquet reçoit la sienne, puis toutes
    // les dates sont recalculées (la dernière révision avant une échéance
    // tombe désormais la veille, et non plus le jour même).
    const paquets = await Donnees.tous('paquets');
    for (const paquet of paquets) {
      if (!paquet.section) {
        paquet.section = Planification.sectionDe(paquet);
        paquet.retentionEntretien = Planification.RETENTION_ENTRETIEN_DEFAUT;
        paquet.modifieLe = new Date().toISOString();
        await Donnees.ecrire('paquets', paquet);
      }
      await Planification.rafraichirPaquet(paquet, reglages);
    }
    await Donnees.majReglages({ versionDonnees: 2 });
  },

  /* Change la section d'un paquet et recalcule ses cartes. */
  async changerSection(paquetId, section) {
    const paquet = await Donnees.lire('paquets', paquetId);
    paquet.section = section;
    // À chaque entrée en Entretenir, la rétention repart à 85 %.
    if (section === 'entretenir') paquet.retentionEntretien = Planification.RETENTION_ENTRETIEN_DEFAUT;
    paquet.modifieLe = new Date().toISOString();
    await Donnees.ecrire('paquets', paquet);
    await Planification.rafraichirPaquet(paquet, await Donnees.reglages());
  },

  // ---------- Navigation ----------

  async aller(nom, contexte, racine) {
    if (racine) {
      this.pile = [];
    } else {
      this.pile.push({ ecran: this.ecran, contexte: this.contexte });
    }
    this.ecran = nom;
    this.contexte = contexte || {};
    await this.rendre();
  },

  async retour() {
    const precedent = this.pile.pop();
    if (!precedent) return this.aller('accueil', {}, true);
    this.ecran = precedent.ecran;
    this.contexte = precedent.contexte;
    await this.rendre();
  },

  async rendre() {
    document.getElementById('bouton-retour').hidden = this.pile.length === 0;
    document.querySelectorAll('#barre-bas .onglet').forEach(bouton => {
      bouton.classList.toggle('actif', bouton.dataset.ecran === this.ecran);
    });
    const fonctions = {
      accueil: this.ecranAccueil,
      paquets: this.ecranPaquets,
      paquet: this.ecranPaquet,
      carte: this.ecranCarte,
      session: this.ecranSession,
      stats: this.ecranStats,
      reglages: this.ecranReglages,
      import: this.ecranImport
    };
    const fonction = fonctions[this.ecran] || this.ecranAccueil;
    await fonction.call(this);
    window.scrollTo(0, 0);
  },

  afficher(titre, html) {
    document.getElementById('titre-ecran').textContent = titre;
    document.getElementById('ecran').innerHTML = html;
  },

  brancher(selecteur, evenement, fonction) {
    document.querySelectorAll(selecteur).forEach(element => {
      element.addEventListener(evenement, fonction);
    });
  },

  // ---------- Écran : accueil ----------

  async ecranAccueil() {
    const jour = Planification.jourAujourdhui();
    const reglages = await Donnees.reglages();
    const paquets = await Donnees.tous('paquets');
    const cartes = await Donnees.tous('cartes');

    const selection = Planification.selectionDuJour(cartes, paquets, reglages, jour, null);
    const actives = cartes.filter(c => c.statut === 'active');
    const brouillons = cartes.filter(c => c.statut === 'brouillon');
    const sangsues = actives.filter(c => Planification.estSangsue(c, reglages));
    const total = selection.total;
    const visibles = paquets.filter(p => !p.archive);

    // Pour chaque paquet : sa part de la sélection du jour (les nombres
    // s'additionnent et redonnent le total), et les cartes qui attendent leur tour.
    const aFaire = {};
    visibles.forEach(p => {
      const jamaisVues = cartes.filter(c => c.paquetId === p.id && !c.etat && Planification.carteEnJeu(c, p)).length;
      const nouvelles = selection.nouvelles.filter(c => c.paquetId === p.id).length;
      aFaire[p.id] = {
        dues: selection.dues.filter(c => c.paquetId === p.id).length,
        nouvelles: nouvelles,
        enAttente: jamaisVues - nouvelles,
        // Réviser ce paquet seul peut lui donner des places que la sélection
        // commune a données à un autre paquet : on le calcule à part.
        seul: Planification.selectionDuJour(cartes, paquets, reglages, jour, [p.id]).total
      };
    });

    let html = '';

    if (cartes.length === 0) {
      html += `<div class="bloc">
        <h2>Rien à réviser pour l'instant</h2>
        <p class="doux">Commence par importer un fichier de cartes (celui que Claude t'a préparé à partir de tes photos de cours), ou crée un paquet à la main.</p>
        <button class="bouton large" data-va="import">Importer un fichier de cartes</button>
        <button class="bouton secondaire large" data-va="paquets">Gérer les paquets</button>
      </div>`;
    } else {
      html += `<div class="bloc centre">
        <div style="font-size:42px;font-weight:700;line-height:1.1">${total}</div>
        <p class="doux">carte${total > 1 ? 's' : ''} à passer aujourd'hui<br>
        ${selection.dues.length} à revoir · ${selection.nouvelles.length} nouvelle${selection.nouvelles.length > 1 ? 's' : ''}</p>
        <button class="bouton large" data-reviser="tout" ${total === 0 ? 'disabled' : ''}>
          ${total === 0 ? 'Rien à réviser maintenant' : 'Réviser'}
        </button>
      </div>`;
    }

    // Paquets urgents : en premier, le contrôle le plus proche d'abord.
    visibles
      .filter(p => Planification.estUrgent(p, jour))
      .sort((a, b) => (a.echeance < b.echeance ? -1 : 1))
      .forEach(p => { html += this.blocUrgent(p, aFaire[p.id], jour); });

    // Changements de section proposés (c'est toi qui décides).
    const suggestions = visibles
      .map(p => ({ paquet: p, suggestion: Planification.suggestionPour(p, jour) }))
      .filter(x => x.suggestion);
    if (suggestions.length > 0) {
      html += '<div class="bloc"><strong>Changement de section proposé</strong>';
      suggestions.forEach(x => { html += this.ligneSuggestion(x.paquet, x.suggestion); });
      html += '</div>';
    }

    if (brouillons.length > 0) {
      html += `<div class="bloc">
        <strong>${brouillons.length} carte${brouillons.length > 1 ? 's' : ''} en attente de validation</strong>
        <p class="doux">Une carte importée n'entre en révision qu'après ta relecture : je peux avoir mal lu une photo, et réviser une carte fausse t'apprendrait l'erreur.</p>
        <button class="bouton secondaire large" data-valider-brouillons="1">Relire les brouillons</button>
      </div>`;
    }

    if (sangsues.length > 0) {
      html += `<div class="bloc">
        <strong class="orange">${sangsues.length} carte${sangsues.length > 1 ? 's' : ''} qui résiste${sangsues.length > 1 ? 'nt' : ''}</strong>
        <p class="doux">Au-delà de ${reglages.seuilSangsue} échecs, le problème vient presque toujours de la carte (trop longue, deux idées en une), pas de ta mémoire. À réécrire ou à découper.</p>
        <button class="bouton secondaire large" data-va="stats">Voir lesquelles</button>
      </div>`;
    }

    // Les autres paquets, rangés par section, dans l'ordre de priorité.
    ['apprendre', 'comprendre', 'entretenir'].forEach(section => {
      const liste = visibles.filter(p => !Planification.estUrgent(p, jour) && Planification.sectionDe(p) === section);
      if (liste.length === 0) return;
      html += `<h2>${Planification.SECTIONS[section].nom}</h2><div class="bloc">`;
      liste.forEach(p => { html += this.ligneAccueil(p, aFaire[p.id], jour); });
      html += '</div>';
    });

    if (Synchro.estConfigure()) {
      html += `<p class="doux centre">Synchronisation : ${Synchro.texteDerniereSynchro()}</p>`;
    }

    this.afficher('Aujourd\'hui', html);
    this.brancher('[data-va]', 'click', e => this.aller(e.currentTarget.dataset.va));
    this.brancher('[data-valider-brouillons]', 'click', () => this.ouvrirBrouillons());
    this.brancher('[data-reviser]', 'click', async e => {
      const cible = e.currentTarget.dataset.reviser;
      await this.lancerSession(cible === 'tout' ? null : [cible]);
    });
    this.brancher('[data-changer-section]', 'click', async e => {
      await this.changerSection(e.currentTarget.dataset.paquet, e.currentTarget.dataset.changerSection);
      await this.rendre();
    });
    this.brancher('[data-archiver-paquet]', 'click', async e => {
      const paquet = await Donnees.lire('paquets', e.currentTarget.dataset.archiverPaquet);
      paquet.archive = true;
      paquet.modifieLe = new Date().toISOString();
      await Donnees.ecrire('paquets', paquet);
      await this.rendre();
    });
    this.brancher('[data-ignorer]', 'click', async e => {
      // On lit le bouton AVANT toute attente (await) : après, le navigateur
      // a déjà oublié quel bouton a été cliqué.
      const cle = e.currentTarget.dataset.ignorer;
      const paquet = await Donnees.lire('paquets', e.currentTarget.dataset.paquet);
      paquet.suggestionIgnoree = cle;
      paquet.modifieLe = new Date().toISOString();
      await Donnees.ecrire('paquets', paquet);
      await this.rendre();
    });
  },

  blocUrgent(paquet, aFaire, jour) {
    const restant = Planification.joursAvantEcheance(paquet, jour);
    const quand = restant === 0 ? 'contrôle aujourd\'hui'
      : restant === 1 ? 'contrôle demain'
      : 'contrôle dans ' + restant + ' jours';
    return `<div class="bloc urgent">
      <div class="etiquette-urgent"><span class="point-urgent"></span>Urgent · ${quand}</div>
      <div class="titre-ligne" style="margin-top:6px">${this.h(paquet.nom)}</div>
      <div class="doux">${Planification.jourLisible(paquet.echeance)} · ${this.texteCompteurs(aFaire)}</div>
      ${aFaire.seul > 0
        ? `<button class="bouton large bouton-urgent" data-reviser="${paquet.id}">Réviser ce paquet (${aFaire.seul})</button>`
        : '<p class="vert" style="margin:8px 0 0">À jour pour aujourd\'hui.</p>'}
    </div>`;
  },

  ligneAccueil(paquet, aFaire, jour) {
    const echeance = paquet.echeance ? ' · ' + this.texteEcheance(paquet.echeance, jour) : '';
    return `<div class="ligne">
      <div class="grandit">
        <div class="titre-ligne">${this.h(paquet.nom)}</div>
        <div class="doux">${this.texteCompteurs(aFaire)}${echeance}</div>
      </div>
      <button class="bouton secondaire" data-reviser="${paquet.id}" ${aFaire.seul === 0 ? 'disabled' : ''}>Réviser</button>
    </div>`;
  },

  texteCompteurs(aFaire) {
    let texte = `${aFaire.dues} à revoir · ${aFaire.nouvelles} nouvelle${aFaire.nouvelles > 1 ? 's' : ''}`;
    if (aFaire.enAttente > 0) texte += ` · ${aFaire.enAttente} en attente`;
    return texte;
  },

  ligneSuggestion(paquet, suggestion) {
    let texte = '';
    let boutons = '';
    if (suggestion.type === 'vers-apprendre') {
      texte = suggestion.restant === 0 ? 'Contrôle aujourd\'hui : passer en Apprendre ?' : `Contrôle dans ${suggestion.restant} j : passer en Apprendre ?`;
      boutons = `<button class="bouton" data-changer-section="apprendre" data-paquet="${paquet.id}">Passer en Apprendre</button>`;
    } else if (suggestion.type === 'apres-controle') {
      texte = 'Le contrôle est passé. Tu gardes ce chapitre, ou tu l\'archives ?';
      boutons = `<button class="bouton" data-changer-section="entretenir" data-paquet="${paquet.id}">Entretenir</button>
        <button class="bouton secondaire" data-archiver-paquet="${paquet.id}">Archiver</button>`;
    } else {
      texte = `Échéance dans ${suggestion.restant} j : repasser en Apprendre ?`;
      boutons = `<button class="bouton" data-changer-section="apprendre" data-paquet="${paquet.id}">Passer en Apprendre</button>`;
    }
    return `<div class="ligne" style="display:block">
      <div class="titre-ligne">${this.h(paquet.nom)}</div>
      <p class="doux" style="margin:4px 0 8px">${texte}</p>
      <div class="rangee-boutons">${boutons}
        <button class="bouton secondaire" data-ignorer="${suggestion.cle}" data-paquet="${paquet.id}">Ignorer</button>
      </div>
    </div>`;
  },

  texteEcheance(echeance, jour) {
    const restant = Planification.differenceEnJours(jour, echeance);
    if (restant < 0) return 'échéance passée';
    if (restant === 0) return 'échéance aujourd\'hui';
    return 'dans ' + restant + ' j';
  },

  async ouvrirBrouillons() {
    const cartes = await Donnees.tous('cartes');
    const brouillon = cartes.find(c => c.statut === 'brouillon');
    if (!brouillon) return this.aller('accueil', {}, true);
    await this.aller('carte', { carteId: brouillon.id, modeValidation: true });
  },

  // ---------- Écran : liste des paquets ----------

  async ecranPaquets() {
    const paquets = await Donnees.tous('paquets');
    const cartes = await Donnees.tous('cartes');

    let html = `<div class="bloc">
      <button class="bouton large" data-va="import">Importer un fichier de cartes</button>
      <button class="bouton secondaire large" data-nouveau-paquet="1">Créer un paquet vide</button>
    </div>`;

    if (paquets.length === 0) {
      html += '<p class="doux">Aucun paquet pour le moment.</p>';
    } else {
      html += '<div class="bloc">';
      paquets.forEach(paquet => {
        const duPaquet = cartes.filter(c => c.paquetId === paquet.id);
        const brouillons = duPaquet.filter(c => c.statut === 'brouillon').length;
        html += `<div class="ligne" data-ouvrir-paquet="${paquet.id}" style="cursor:pointer">
          <div class="grandit">
            <div class="titre-ligne">${this.h(paquet.nom)}${paquet.archive ? ' <span class="doux">(archivé)</span>' : ''}</div>
            <div class="doux">${this.h(paquet.matiere || 'sans matière')} · ${duPaquet.length} carte${duPaquet.length > 1 ? 's' : ''}${paquet.echeance ? ' · échéance ' + Planification.jourLisible(paquet.echeance) : ''}</div>
          </div>
          ${brouillons > 0 ? `<span class="pastille alerte">${brouillons} à valider</span>` : ''}
          <span class="pastille section-${Planification.sectionDe(paquet)}">${Planification.SECTIONS[Planification.sectionDe(paquet)].nom}</span>
          <span class="doux">›</span>
        </div>`;
      });
      html += '</div>';
    }

    this.afficher('Paquets', html);
    this.brancher('[data-va]', 'click', e => this.aller(e.currentTarget.dataset.va));
    this.brancher('[data-ouvrir-paquet]', 'click', e => this.aller('paquet', { paquetId: e.currentTarget.dataset.ouvrirPaquet }));
    this.brancher('[data-nouveau-paquet]', 'click', async () => {
      const maintenant = new Date().toISOString();
      const paquet = {
        id: Donnees.nouvelId(), nom: 'Nouveau paquet', matiere: '', echeance: null,
        section: 'comprendre', retentionEntretien: Planification.RETENTION_ENTRETIEN_DEFAUT,
        retentionCible: null, archive: false, creeLe: maintenant, modifieLe: maintenant
      };
      await Donnees.ecrire('paquets', paquet);
      await this.aller('paquet', { paquetId: paquet.id });
    });
  },

  // ---------- Écran : un paquet ----------

  async ecranPaquet() {
    const paquet = await Donnees.lire('paquets', this.contexte.paquetId);
    if (!paquet) return this.aller('paquets', {}, true);
    const cartes = (await Donnees.tous('cartes')).filter(c => c.paquetId === paquet.id);
    const jour = Planification.jourAujourdhui();

    const brouillons = cartes.filter(c => c.statut === 'brouillon');
    const actives = cartes.filter(c => c.statut === 'active');
    const suspendues = cartes.filter(c => c.statut === 'suspendue');
    const acquises = actives.filter(c => c.etat && c.etat.acquise).length;
    const section = Planification.sectionDe(paquet);
    const enJeu = actives.filter(c => Planification.carteEnJeu(c, paquet)).length;
    const retention = paquet.retentionEntretien || Planification.RETENTION_ENTRETIEN_DEFAUT;

    let html = `<div class="bloc">
      <h2>Section</h2>
      <div class="segments">
        ${Object.keys(Planification.SECTIONS).map(cle =>
          `<button data-section="${cle}" class="${cle === section ? 'actif' : ''}">${Planification.SECTIONS[cle].nom}</button>`).join('')}
      </div>
      <p class="doux">${Planification.SECTIONS[section].description}</p>
      ${section === 'entretenir' ? `
        <label>Rétention visée pour ce paquet</label>
        <div class="segments">
          ${[0.8, 0.85, 0.9].map(valeur =>
            `<button data-retention="${valeur}" class="${Math.abs(valeur - retention) < 0.001 ? 'actif' : ''}">${Math.round(valeur * 100)} %</button>`).join('')}
        </div>
        <p class="doux">Par rapport à 90 %, les intervalles sont environ 1,9 fois plus longs à 85 %, et 3,3 fois plus longs à 80 %. Moins de révisions, mais davantage d'oublis à chaque passage.</p>` : ''}
      <p><strong>${enJeu}</strong> carte${enJeu > 1 ? 's' : ''} en jeu sur ${actives.length} active${actives.length > 1 ? 's' : ''}.</p>
    </div>

    <div class="bloc">
      <label for="nom-paquet">Nom</label>
      <input type="text" id="nom-paquet" value="${this.h(paquet.nom)}">
      <label for="matiere-paquet">Matière</label>
      <input type="text" id="matiere-paquet" value="${this.h(paquet.matiere || '')}" placeholder="Physique-chimie, 2I2D, Philosophie…">
      <label for="echeance-paquet">Échéance (contrôle, bac…) — laisse vide si c'est du long terme</label>
      <input type="date" id="echeance-paquet" value="${paquet.echeance || ''}">
      <p class="doux">Aucune révision ne sera planifiée après cette date : la dernière tombera la veille.</p>
      <button class="bouton" data-enregistrer-paquet="1">Enregistrer</button>
      <button class="bouton secondaire" data-archiver="1">${paquet.archive ? 'Réactiver' : 'Archiver'}</button>
    </div>

    <div class="bloc">
      <div class="ligne"><div class="grandit">Cartes actives</div><strong>${actives.length}</strong></div>
      <div class="ligne"><div class="grandit">Acquises (3 rappels réussis espacés)</div><strong>${acquises}</strong></div>
      <div class="ligne"><div class="grandit">À valider</div><strong>${brouillons.length}</strong></div>
      <div class="ligne"><div class="grandit">Suspendues</div><strong>${suspendues.length}</strong></div>
      <button class="bouton secondaire large" data-nouvelle-carte="1">Ajouter une carte</button>
    </div>`;

    html += '<h2>Cartes</h2><div class="bloc">';
    if (cartes.length === 0) {
      html += '<p class="doux">Ce paquet est vide.</p>';
    }
    cartes
      .slice()
      .sort((a, b) => (a.statut === 'brouillon' ? -1 : 0) - (b.statut === 'brouillon' ? -1 : 0))
      .forEach(carte => {
        let etiquette = '';
        if (carte.statut === 'brouillon') etiquette = '<span class="pastille alerte">à valider</span>';
        else if (carte.statut === 'suspendue') etiquette = '<span class="pastille">suspendue</span>';
        else if (!Planification.carteEnJeu(carte, paquet)) etiquette = '<span class="pastille">hors section</span>';
        else if (carte.etat && carte.etat.acquise) etiquette = '<span class="pastille ok">acquise</span>';
        else if (carte.etat) etiquette = `<span class="pastille">${Planification.jourLisible(carte.etat.dueLe)}</span>`;
        else etiquette = '<span class="pastille">nouvelle</span>';
        html += `<div class="ligne" data-ouvrir-carte="${carte.id}" style="cursor:pointer">
          <div class="grandit">
            <div>${this.h(this.extrait(carte.question, 90))}</div>
            <div class="doux">${carte.type === 'explique' ? 'Explique' : 'Rappel'}${carte.etat ? ' · ' + carte.etat.echecs + ' échec(s)' : ''}</div>
          </div>${etiquette}
        </div>`;
      });
    html += '</div>';

    html += `<div class="bloc">
      <button class="bouton danger large" data-supprimer-paquet="1">Supprimer ce paquet et ses cartes</button>
    </div>`;

    this.afficher(paquet.nom, html);

    this.brancher('[data-enregistrer-paquet]', 'click', async () => {
      paquet.nom = document.getElementById('nom-paquet').value.trim() || 'Sans nom';
      paquet.matiere = document.getElementById('matiere-paquet').value.trim();
      paquet.echeance = document.getElementById('echeance-paquet').value || null;
      paquet.modifieLe = new Date().toISOString();
      await Donnees.ecrire('paquets', paquet);
      // Les dates dépendent de l'échéance : on recalcule les cartes du paquet.
      const reglages = await Donnees.reglages();
      for (const carte of cartes) {
        if (carte.etat) await Planification.rafraichirCarte(carte, paquet, reglages);
      }
      await this.rendre();
    });

    this.brancher('[data-archiver]', 'click', async () => {
      paquet.archive = !paquet.archive;
      paquet.modifieLe = new Date().toISOString();
      await Donnees.ecrire('paquets', paquet);
      await this.rendre();
    });

    this.brancher('[data-section]', 'click', async e => {
      const nouvelle = e.currentTarget.dataset.section;
      if (nouvelle === section) return;
      await this.changerSection(paquet.id, nouvelle);
      await this.rendre();
    });

    this.brancher('[data-retention]', 'click', async e => {
      paquet.retentionEntretien = Number(e.currentTarget.dataset.retention);
      paquet.modifieLe = new Date().toISOString();
      await Donnees.ecrire('paquets', paquet);
      await Planification.rafraichirPaquet(paquet, await Donnees.reglages());
      await this.rendre();
    });

    this.brancher('[data-ouvrir-carte]', 'click', e => this.aller('carte', { carteId: e.currentTarget.dataset.ouvrirCarte }));

    this.brancher('[data-nouvelle-carte]', 'click', async () => {
      const maintenant = new Date().toISOString();
      const carte = {
        id: Donnees.nouvelId(), paquetId: paquet.id, type: 'rappel',
        question: '', elementsCles: [], reponse: '', exemples: [], maFormulation: '',
        surPapier: false, comprendre: true, essentiel: true, source: '', statut: 'brouillon', etat: null,
        ordre: cartes.length, creeLe: maintenant, modifieLe: maintenant
      };
      await Donnees.ecrire('cartes', carte);
      await this.aller('carte', { carteId: carte.id });
    });

    this.brancher('[data-supprimer-paquet]', 'click', async () => {
      if (!confirm('Supprimer « ' + paquet.nom + ' » et ses ' + cartes.length + ' cartes ? Les révisions déjà faites seront perdues.')) return;
      for (const carte of cartes) await Donnees.supprimer('cartes', carte.id);
      await Donnees.supprimer('paquets', paquet.id);
      await this.aller('paquets', {}, true);
    });
  },

  extrait(texte, longueur) {
    const propre = String(texte || '').replace(/\s+/g, ' ').trim();
    return propre.length > longueur ? propre.slice(0, longueur) + '…' : (propre || '(carte vide)');
  },

  // ---------- Écran : une carte (édition / validation) ----------

  async ecranCarte() {
    const carte = await Donnees.lire('cartes', this.contexte.carteId);
    if (!carte) return this.retour();
    const paquet = await Donnees.lire('paquets', carte.paquetId);

    let etatHtml = '<p class="doux">Jamais révisée.</p>';
    if (carte.etat) {
      etatHtml = `<p class="doux">Prochaine révision : ${Planification.jourLisible(carte.etat.dueLe)} ·
        ${carte.etat.nbRevisions} révision(s) · ${carte.etat.echecs} échec(s) ·
        stabilité ${carte.etat.stabilite.toFixed(1)} j · difficulté ${carte.etat.difficulte.toFixed(1)}/10</p>`;
    }

    const html = `
    <div class="bloc">
      <label for="type-carte">Type de carte</label>
      <select id="type-carte">
        <option value="rappel" ${carte.type === 'rappel' ? 'selected' : ''}>Rappel — restituer la réponse</option>
        <option value="explique" ${carte.type === 'explique' ? 'selected' : ''}>Explique — reformuler / justifier avec tes mots</option>
      </select>

      <label for="question-carte">Question (recto)</label>
      <textarea id="question-carte" rows="3">${this.h(carte.question)}</textarea>

      <label for="elements-carte">Éléments clés attendus — un par ligne</label>
      <textarea id="elements-carte" rows="4" placeholder="Chaque ligne est une case à cocher au moment de te corriger.">${this.h((carte.elementsCles || []).join('\n'))}</textarea>
      <p class="doux">S'il en faut plus de 3 ou 4, la carte est trop grosse : mieux vaut la couper en deux.</p>

      <label for="reponse-carte">Réponse de référence (verso)</label>
      <textarea id="reponse-carte" rows="4">${this.h(carte.reponse)}</textarea>

      <label for="exemples-carte">Exemples — un par ligne</label>
      <textarea id="exemples-carte" rows="3">${this.h((carte.exemples || []).join('\n'))}</textarea>

      <label for="formulation-carte">Ma formulation (écrite une fois, relue à chaque verso)</label>
      <textarea id="formulation-carte" rows="3" placeholder="La même idée avec tes mots à toi.">${this.h(carte.maFormulation || '')}</textarea>

      <label><input type="checkbox" id="papier-carte" ${carte.surPapier ? 'checked' : ''}> Répondre sur papier (pas de saisie au clavier)</label>
      <label><input type="checkbox" id="comprendre-carte" ${carte.comprendre !== false ? 'checked' : ''}> Compréhension ou méthode : en jeu dès la section Comprendre</label>
      <label><input type="checkbox" id="essentiel-carte" ${carte.essentiel !== false ? 'checked' : ''}> Essentielle : gardée en section Entretenir</label>
      ${carte.source ? `<p class="doux">Source : ${this.h(carte.source)}</p>` : ''}
      ${etatHtml}
    </div>

    <div class="bloc">
      <button class="bouton large" data-enregistrer-carte="1">${carte.statut === 'brouillon' ? 'Valider cette carte (elle entrera en révision)' : 'Enregistrer'}</button>
      ${carte.statut === 'brouillon' ? '<button class="bouton secondaire large" data-enregistrer-brouillon="1">Enregistrer sans valider</button>' : ''}
      ${carte.statut === 'active' ? '<button class="bouton secondaire large" data-suspendre="1">Suspendre (ne plus la voir en session)</button>' : ''}
      ${carte.statut === 'suspendue' ? '<button class="bouton secondaire large" data-reactiver="1">Remettre en révision</button>' : ''}
      <button class="bouton danger large" data-supprimer-carte="1">Supprimer</button>
    </div>`;

    this.afficher(carte.statut === 'brouillon' ? 'Carte à valider' : 'Carte', html);

    const lire = () => {
      carte.type = document.getElementById('type-carte').value;
      carte.question = document.getElementById('question-carte').value.trim();
      carte.reponse = document.getElementById('reponse-carte').value.trim();
      carte.elementsCles = document.getElementById('elements-carte').value.split('\n').map(l => l.trim()).filter(Boolean);
      carte.exemples = document.getElementById('exemples-carte').value.split('\n').map(l => l.trim()).filter(Boolean);
      carte.maFormulation = document.getElementById('formulation-carte').value.trim();
      carte.surPapier = document.getElementById('papier-carte').checked;
      carte.comprendre = document.getElementById('comprendre-carte').checked;
      carte.essentiel = document.getElementById('essentiel-carte').checked;
      carte.modifieLe = new Date().toISOString();
    };

    const suivantOuRetour = async () => {
      if (!this.contexte.modeValidation) return this.retour();
      const restant = (await Donnees.tous('cartes')).find(c => c.statut === 'brouillon');
      if (restant) {
        this.contexte = { carteId: restant.id, modeValidation: true };
        return this.rendre();
      }
      return this.aller('accueil', {}, true);
    };

    this.brancher('[data-enregistrer-carte]', 'click', async () => {
      lire();
      if (!carte.question) { alert('Il faut au moins une question.'); return; }
      if (carte.statut === 'brouillon') carte.statut = 'active';
      await Donnees.ecrire('cartes', carte);
      await suivantOuRetour();
    });

    this.brancher('[data-enregistrer-brouillon]', 'click', async () => {
      lire();
      await Donnees.ecrire('cartes', carte);
      await suivantOuRetour();
    });

    this.brancher('[data-suspendre]', 'click', async () => {
      lire(); carte.statut = 'suspendue';
      await Donnees.ecrire('cartes', carte);
      await this.retour();
    });

    this.brancher('[data-reactiver]', 'click', async () => {
      lire(); carte.statut = 'active';
      await Donnees.ecrire('cartes', carte);
      await this.retour();
    });

    this.brancher('[data-supprimer-carte]', 'click', async () => {
      if (!confirm('Supprimer cette carte ?')) return;
      await Donnees.supprimer('cartes', carte.id);
      await suivantOuRetour();
    });
  },

  // ---------- Écran : session ----------

  async lancerSession(paquetsChoisis) {
    const resume = await Session.preparer(paquetsChoisis);
    if (resume.total === 0) {
      alert('Rien à réviser dans cette sélection pour aujourd\'hui.');
      return;
    }
    this.phaseSession = 'question';
    this.brouillonReponse = '';
    this.confianceChoisie = null;
    this.elementsCoches = [];
    this.synchroFinFaite = false;
    await this.aller('session', {}, true);
  },

  async ecranSession() {
    if (Session.terminee() && this.phaseSession !== 'fin') this.phaseSession = 'fin';

    if (this.phaseSession === 'fin') {
      const c = Session.compteur;
      const taux = c.vues > 0 ? Math.round(100 * c.reussies / c.vues) : 0;
      // Fin de session : on envoie le travail à l'autre appareil, une seule fois.
      if (!this.synchroFinFaite && Synchro.estConfigure()) {
        this.synchroFinFaite = true;
        Synchro.synchroniserEnFond();
      }
      this.afficher('Session terminée', `<div class="bloc centre">
        <h2>Terminé</h2>
        <p>${c.vues} réponses · ${taux} % de réussite · ${c.ratees} échec(s)</p>
        <p class="doux">Tout est déjà enregistré. Les cartes ratées reviendront demain.</p>
        <button class="bouton large" data-va="accueil">Retour à l'accueil</button>
      </div>`);
      this.brancher('[data-va]', 'click', () => this.aller('accueil', {}, true));
      return;
    }

    const carte = Session.carteCourante();
    const paquet = Session.paquetCourant();
    const avancement = Math.round(100 * Session.position / Session.file.length);
    const entete = `<div class="barre-progression"><div style="width:${avancement}%"></div></div>
      <p class="doux">${Session.restantes()} restante(s) · ${this.h(paquet ? paquet.nom : '')} ·
      ${carte.type === 'explique' ? 'Explique avec tes mots' : 'Rappel'}${Session.entreeCourante().repetition ? ' · reprise' : ''}</p>`;

    if (this.phaseSession === 'question') {
      this.afficher('Révision', entete + `
        <div id="zone-question"><div class="question">${this.h(carte.question)}</div></div>
        <div id="zone-reponse">
          ${carte.surPapier
            ? '<p class="doux">Réponds sur papier, puis valide.</p>'
            : `<label for="reponse">Ta réponse — écris-la avant de voir la correction</label>
               <textarea id="reponse" autocomplete="off">${this.h(this.brouillonReponse)}</textarea>`}
          <button class="bouton large" data-valider-reponse="1">J'ai répondu</button>
        </div>`);
      const zone = document.getElementById('reponse');
      if (zone) zone.addEventListener('input', () => { this.brouillonReponse = zone.value; });
      this.brancher('[data-valider-reponse]', 'click', () => {
        if (zone) this.brouillonReponse = zone.value;
        this.phaseSession = 'confiance';
        this.rendre();
      });
      return;
    }

    if (this.phaseSession === 'confiance') {
      const niveaux = [
        [1, 'Aucune idée', 'je n\'ai rien pu produire'],
        [2, 'Hésitant', 'je ne parierais pas dessus'],
        [3, 'Plutôt sûr', 'je pense que c\'est bon'],
        [4, 'Certain', 'j\'en suis sûr']
      ];
      this.afficher('Révision', entete + `
        <div class="bloc">
          <h2>À quel point es-tu sûr de la réponse que tu viens d'écrire ?</h2>
          <p class="doux">Tu juges ta réponse, pas la question. C'est ce qui permet de mesurer l'écart entre ce que tu crois savoir et ce que tu sais.</p>
          <div class="boutons-confiance">
            ${niveaux.map(n => `<button data-confiance="${n[0]}"><strong>${n[1]}</strong><small>${n[2]}</small></button>`).join('')}
          </div>
        </div>`);
      this.brancher('[data-confiance]', 'click', e => {
        this.confianceChoisie = Number(e.currentTarget.dataset.confiance);
        this.elementsCoches = (carte.elementsCles || []).map(() => false);
        this.interactionVerso = false;   // l'avertissement n'apparaît qu'après ta correction
        this.phaseSession = 'verso';
        this.rendre();
      });
      return;
    }

    // --- Verso : correction ---
    const reglages = await Donnees.reglages();
    const etatActuel = carte.etat ? { stabilite: carte.etat.stabilite, difficulte: carte.etat.difficulte } : null;
    const dernierJour = carte.etat ? carte.etat.dernierJour : null;
    const aujourdHui = Planification.jourAujourdhui();
    const joursEcoules = (etatActuel && dernierJour) ? Planification.differenceEnJours(dernierJour, aujourdHui) : 0;

    const apercu = {};
    for (let note = 1; note <= 4; note++) {
      const memoire = FSRS.prochainEtat(etatActuel, joursEcoules, note);
      apercu[note] = Planification.calculerIntervalle(memoire.stabilite, aujourdHui, paquet, reglages, null);
    }

    const elements = carte.elementsCles || [];
    this.afficher('Correction', entete + `
      ${carte.surPapier ? '' : `<div class="bloc"><label>Ce que tu as écrit</label><div class="ma-reponse">${this.h(this.brouillonReponse) || '<em class="doux">(rien)</em>'}</div></div>`}

      <div class="bloc">
        <h2>Réponse de référence</h2>
        ${elements.length > 0 ? `
          <p class="doux">Coche ce que tu avais vraiment. Un seul élément manquant = Raté : c'est volontairement sévère, sinon on se surestime.</p>
          ${elements.map((element, i) => `<label class="element-cle"><input type="checkbox" data-element="${i}"><span>${this.h(element)}</span></label>`).join('')}
        ` : ''}
        ${carte.reponse ? `<p style="white-space:pre-wrap">${this.h(carte.reponse)}</p>` : ''}
        ${(carte.exemples || []).length > 0 ? `<p class="doux">Exemples</p><ul>${carte.exemples.map(ex => `<li style="white-space:pre-wrap">${this.h(ex)}</li>`).join('')}</ul>` : ''}
        ${carte.maFormulation ? `<p class="doux">Ta formulation</p><p style="white-space:pre-wrap">${this.h(carte.maFormulation)}</p>` : ''}
      </div>

      <div id="zone-avertissement"></div>

      <div class="bloc">
        <h2>Ta note</h2>
        <div class="boutons-note">
          <button data-note="1"><strong>Raté</strong><small>→ ${apercu[1]} j</small></button>
          <button data-note="2"><strong>Difficile</strong><small>tout, mais laborieux · ${apercu[2]} j</small></button>
          <button data-note="3"><strong>Correct</strong><small>→ ${apercu[3]} j</small></button>
          <button data-note="4"><strong>Facile</strong><small>immédiat · ${apercu[4]} j</small></button>
        </div>
      </div>`);

    const majSuggestion = () => {
      const tousCoches = elements.length === 0 || this.elementsCoches.every(Boolean);
      document.querySelectorAll('[data-note]').forEach(bouton => {
        const note = Number(bouton.dataset.note);
        bouton.classList.toggle('suggeree', tousCoches ? note === 3 : note === 1);
      });
      const zone = document.getElementById('zone-avertissement');
      // On n'affiche l'avertissement qu'une fois que tu as commencé à cocher :
      // sinon il s'afficherait avant même que tu aies lu la référence.
      if (this.interactionVerso && !tousCoches && this.confianceChoisie >= 3) {
        // Erreur commise avec confiance : c'est exactement le cas où le
        // feedback corrige le mieux, à condition d'y prêter attention.
        zone.innerHTML = '<div class="avertissement">Tu te disais sûr et il manque quelque chose. Relis la référence maintenant, ligne par ligne : ce sont ces erreurs-là qui se corrigent le mieux.</div>';
      } else {
        zone.innerHTML = '';
      }
    };
    majSuggestion();

    this.brancher('[data-element]', 'change', e => {
      this.elementsCoches[Number(e.currentTarget.dataset.element)] = e.currentTarget.checked;
      this.interactionVerso = true;
      majSuggestion();
    });

    this.brancher('[data-note]', 'click', async e => {
      await Session.enregistrer({
        note: Number(e.currentTarget.dataset.note),
        confiance: this.confianceChoisie,
        reponseTapee: this.brouillonReponse,
        elementsCoches: this.elementsCoches.slice()
      });
      this.brouillonReponse = '';
      this.confianceChoisie = null;
      this.elementsCoches = [];
      this.phaseSession = Session.terminee() ? 'fin' : 'question';
      await this.rendre();
    });
  },

  // ---------- Écran : suivi ----------

  async ecranStats() {
    const jour = Planification.jourAujourdhui();
    const reglages = await Donnees.reglages();
    const cartes = await Donnees.tous('cartes');
    const revisions = await Donnees.tous('revisions');
    const actives = cartes.filter(c => c.statut === 'active');

    // Prévision des 7 prochains jours.
    const prevision = [];
    for (let i = 0; i < 7; i++) {
      const j = Planification.ajouterJours(jour, i);
      const nombre = actives.filter(c => c.etat && (i === 0 ? c.etat.dueLe <= j : c.etat.dueLe === j)).length;
      prevision.push({ jour: j, nombre: nombre });
    }
    const maximum = Math.max(1, ...prevision.map(p => p.nombre));

    // Révisions des 30 derniers jours (celles qui comptent, pas les reprises).
    const limite = Planification.ajouterJours(jour, -30);
    const recentes = revisions.filter(r => r.planifie !== false && r.date.slice(0, 10) >= limite);
    const reussies = recentes.filter(r => r.note >= 2).length;
    const taux = recentes.length > 0 ? Math.round(100 * reussies / recentes.length) : null;

    // Calibration : confiance annoncée vs réussite réelle.
    const noms = { 1: 'Aucune idée', 2: 'Hésitant', 3: 'Plutôt sûr', 4: 'Certain' };
    const lignes = [1, 2, 3, 4].map(niveau => {
      const duNiveau = recentes.filter(r => r.confiance === niveau);
      const ok = duNiveau.filter(r => r.note >= 2).length;
      return {
        nom: noms[niveau],
        nombre: duNiveau.length,
        taux: duNiveau.length > 0 ? Math.round(100 * ok / duNiveau.length) : null
      };
    });

    const sangsues = actives.filter(c => Planification.estSangsue(c, reglages));
    const acquises = actives.filter(c => c.etat && c.etat.acquise).length;
    const jamaisVues = actives.filter(c => !c.etat).length;

    let html = `<div class="bloc">
      <h2>Charge des 7 prochains jours</h2>
      <div class="histogramme">
        ${prevision.map(p => `<div class="colonne"><div class="barre" style="height:${Math.round(100 * p.nombre / maximum)}%" title="${p.nombre}"></div><div class="jour">${p.nombre}</div></div>`).join('')}
      </div>
      <div class="histogramme" style="height:auto">
        ${prevision.map(p => `<div class="colonne"><div class="jour">${Planification.jourLisible(p.jour).split(' ')[0]}</div></div>`).join('')}
      </div>
    </div>

    <div class="bloc">
      <div class="ligne"><div class="grandit">Cartes actives</div><strong>${actives.length}</strong></div>
      <div class="ligne"><div class="grandit">Acquises</div><strong>${acquises}</strong></div>
      <div class="ligne"><div class="grandit">Jamais vues</div><strong>${jamaisVues}</strong></div>
      <div class="ligne"><div class="grandit">Réussite sur 30 jours</div><strong>${taux === null ? '—' : taux + ' %'}</strong></div>
      <p class="doux">Une réussite autour de 90 % est normale : c'est la cible réglée. Beaucoup plus haut veut dire que tu révises trop tôt, beaucoup plus bas que les cartes sont trop grosses.</p>
    </div>

    <div class="bloc">
      <h2>Calibration</h2>
      <p class="doux">Ce que tu annonces, comparé à ce qui se passe vraiment. Sur 30 jours.</p>
      <table>
        <tr><th>Confiance annoncée</th><th>Réponses</th><th>Réussite réelle</th></tr>
        ${lignes.map(l => `<tr><td>${l.nom}</td><td>${l.nombre}</td><td>${l.taux === null ? '—' : l.taux + ' %'}</td></tr>`).join('')}
      </table>
    </div>`;

    if (sangsues.length > 0) {
      html += `<div class="bloc">
        <h2 class="orange">Cartes à réécrire (${sangsues.length})</h2>
        <p class="doux">Au moins ${reglages.seuilSangsue} échecs. Découpe-les, ou reformule la question.</p>
        ${sangsues.map(c => `<div class="ligne" data-ouvrir-carte="${c.id}" style="cursor:pointer">
          <div class="grandit">${this.h(this.extrait(c.question, 80))}</div>
          <span class="pastille alerte">${c.etat.echecs} échecs</span></div>`).join('')}
      </div>`;
    }

    this.afficher('Suivi', html);
    this.brancher('[data-ouvrir-carte]', 'click', e => this.aller('carte', { carteId: e.currentTarget.dataset.ouvrirCarte }));
  },

  // ---------- Écran : import ----------

  async ecranImport() {
    const html = `<div class="bloc">
      <h2>Importer des cartes</h2>
      <p class="doux">Le fichier .json préparé par Claude à partir de tes photos de cours. Les cartes arrivent en brouillon : tu les relis avant qu'elles entrent en révision.</p>
      <div class="avertissement">À faire sur <strong>un seul appareil</strong> (ton PC). Sur l'autre, passe par
      Réglages → Importer et fusionner. Importer le même fichier de cartes des deux côtés créerait
      les mêmes questions en double, avec deux historiques séparés.</div>
      <!-- Pas de filtre "accept" : le sélecteur de fichiers d'Android grise
           parfois les .json quand on en met un. Mieux vaut tout afficher. -->
      <input type="file" id="fichier-cartes">
      <label for="colle-cartes">…ou colle le contenu ici</label>
      <textarea id="colle-cartes" rows="5" placeholder='{"format":"cartes-v1", …}'></textarea>
      <button class="bouton large" data-importer-colle="1">Importer le texte collé</button>
      <div id="resultat-import"></div>
    </div>`;
    this.afficher('Importer', html);

    const traiter = async (donnees) => {
      const zone = document.getElementById('resultat-import');
      try {
        const rapport = await Sauvegarde.importerCartes(donnees);
        zone.innerHTML = `<div class="bloc"><strong>${rapport.ajoutees} carte(s) importée(s)</strong>
          dans « ${this.h(rapport.paquet.nom) }»${rapport.paquetCree ? ' (paquet créé)' : ''}.
          ${rapport.misesAJour > 0 ? rapport.misesAJour + ' déjà présente(s), marquage complété.' : ''}
          ${rapport.ignorees > 0 ? rapport.ignorees + ' déjà présente(s), ignorée(s).' : ''}
          <button class="bouton large" data-valider-brouillons="1">Relire les brouillons maintenant</button></div>`;
        this.brancher('[data-valider-brouillons]', 'click', () => this.ouvrirBrouillons());
      } catch (erreur) {
        zone.innerHTML = `<div class="avertissement">${this.h(erreur.message)}</div>`;
      }
    };

    document.getElementById('fichier-cartes').addEventListener('change', async e => {
      if (!e.target.files[0]) return;
      try { await traiter(await Sauvegarde.lireFichier(e.target.files[0])); }
      catch (erreur) { alert(erreur.message); }
    });

    this.brancher('[data-importer-colle]', 'click', async () => {
      const texte = document.getElementById('colle-cartes').value.trim();
      if (!texte) return;
      try { await traiter(JSON.parse(texte)); }
      catch (erreur) { alert('Texte illisible : ' + erreur.message); }
    });
  },

  // ---------- Écran : réglages ----------

  async ecranReglages() {
    const reglages = await Donnees.reglages();
    const protege = (navigator.storage && navigator.storage.persisted) ? await navigator.storage.persisted() : false;

    const synchroReglages = Synchro.reglages();
    const synchroPrete = Synchro.estConfigure();

    const formulaireSynchro = `
      <label for="synchro-depot">Dépôt privé (utilisateur/dépôt)</label>
      <input type="text" id="synchro-depot" value="${this.h(synchroReglages.depot || '')}" placeholder="samoryx/revisions-donnees" autocapitalize="off" autocorrect="off" spellcheck="false">
      <label for="synchro-jeton">Jeton d'accès</label>
      <input type="password" id="synchro-jeton" value="${this.h(synchroReglages.jeton || '')}" placeholder="github_pat_…" autocapitalize="off" autocorrect="off" spellcheck="false">
      <label for="synchro-phrase">Phrase de passe (la même sur les deux appareils)</label>
      <input type="password" id="synchro-phrase" value="${this.h(synchroReglages.phrase || '')}" autocapitalize="off" autocorrect="off" spellcheck="false">
      <p class="doux">Cette phrase chiffre tes données avant l'envoi : sans elle, le fichier déposé sur GitHub est illisible. Elle ne part jamais nulle part. Si tu l'oublies, tu perds la synchronisation, pas tes cartes.</p>
      <button class="bouton large" data-activer-synchro="1">${synchroPrete ? 'Enregistrer et synchroniser' : 'Activer la synchronisation'}</button>`;

    const html = `<div class="bloc">
      <h2>Synchronisation automatique</h2>
      ${synchroPrete ? `
        <p class="doux">Dépôt : <strong>${this.h(synchroReglages.depot)}</strong><br>
        Dernière synchronisation : <strong>${Synchro.texteDerniereSynchro()}</strong></p>
        ${synchroReglages.dernierMessage ? `<div class="avertissement">${this.h(synchroReglages.dernierMessage)}</div>` : ''}
        <button class="bouton large" data-synchro="1">Synchroniser maintenant</button>
        <div id="resultat-synchro"></div>
        <details style="margin-top:10px"><summary class="doux">Modifier les réglages</summary>${formulaireSynchro}
          <button class="bouton secondaire large" data-oublier-synchro="1">Oublier ces réglages sur cet appareil</button>
        </details>`
      : `<p class="doux">Elle évite le câble : chaque appareil dépose et récupère les révisions tout seul, dans un dépôt privé qui t'appartient. Les données sont chiffrées avant l'envoi. La marche à suivre pour créer le dépôt et le jeton est dans le LISEZ-MOI.</p>
        ${formulaireSynchro}
        <div id="resultat-synchro"></div>`}
    </div>

    <div class="bloc">
      <h2>Sauvegarde et transfert</h2>
      <p class="doux">Le fichier exporté contient tout : paquets, cartes et journal des révisions. Sur l'autre appareil, « Importer et fusionner » additionne les deux journaux sans rien écraser.</p>
      <button class="bouton large" data-exporter="1">Exporter une sauvegarde</button>
      <label for="fichier-sauvegarde">Importer et fusionner une sauvegarde (fichier .json)</label>
      <input type="file" id="fichier-sauvegarde">
      <div id="resultat-fusion"></div>
      <p class="doux">Dernière sauvegarde : ${reglages.derniereSauvegarde ? new Date(reglages.derniereSauvegarde).toLocaleString('fr-FR') : 'jamais'}</p>
    </div>

    <div class="bloc">
      <h2>Rythme</h2>
      <label for="nouvelles">Nouvelles cartes par jour (maximum)</label>
      <input type="number" id="nouvelles" min="0" max="100" value="${reglages.nouvellesParJour}">
      <p class="doux">Chaque nouvelle carte revient ensuite plusieurs fois. En mettre 20 par jour crée une charge qui n'apparaît qu'une semaine plus tard.</p>

      <label for="retention">Rétention visée</label>
      <select id="retention">
        <option value="0.85" ${reglages.retentionCible === 0.85 ? 'selected' : ''}>85 % — moins de révisions, plus d'oublis</option>
        <option value="0.9" ${reglages.retentionCible === 0.9 ? 'selected' : ''}>90 % — réglage par défaut</option>
        <option value="0.95" ${reglages.retentionCible === 0.95 ? 'selected' : ''}>95 % — sûr mais beaucoup plus de travail</option>
      </select>

      <label for="plafond">Intervalle maximum (jours)</label>
      <input type="number" id="plafond" min="7" max="365" value="${reglages.intervalleMaxJours}">
      <p class="doux">Garde-fou contre les contrôles surprises : aucune carte ne disparaît plus longtemps que ça.</p>

      <label for="sangsue">Nombre d'échecs avant de signaler une carte</label>
      <input type="number" id="sangsue" min="2" max="20" value="${reglages.seuilSangsue}">

      <label for="appareil">Nom de cet appareil</label>
      <input type="text" id="appareil" value="${this.h(reglages.nomAppareil)}" placeholder="PC ou Téléphone">

      <button class="bouton large" data-enregistrer-reglages="1">Enregistrer</button>
    </div>

    <div class="bloc">
      <h2>Stockage</h2>
      <p class="doux">${protege
        ? 'Les données sont marquées comme persistantes : le navigateur ne les effacera pas tout seul.'
        : 'Le navigateur peut encore effacer ces données s\'il manque de place. Exporte une sauvegarde régulièrement.'}</p>
      ${protege ? '' : '<button class="bouton secondaire large" data-proteger="1">Demander la protection des données</button>'}
      <button class="bouton danger large" data-tout-effacer="1">Tout effacer</button>
    </div>`;

    this.afficher('Réglages', html);

    // --- Synchronisation ---

    const afficherResultatSynchro = resultat => {
      const zone = document.getElementById('resultat-synchro');
      if (!zone) return;
      if (resultat.etat === 'ok') {
        zone.innerHTML = `<div class="bloc"><strong class="vert">Synchronisé.</strong>
          ${resultat.recu.revisions} révision(s) reçue(s) de l'autre appareil,
          ${resultat.recu.cartes} carte(s), ${resultat.recu.paquets} paquet(s).
          Fichier envoyé : ${Math.round(resultat.taille / 1024)} Ko.
          ${resultat.alerteTaille ? '<br><strong class="orange">Le fichier devient gros : signale-le à Claude.</strong>' : ''}</div>`;
      } else if (resultat.etat === 'erreur') {
        zone.innerHTML = `<div class="avertissement">${this.h(resultat.message)}</div>`;
      } else if (resultat.etat === 'hors-ligne') {
        zone.innerHTML = '<div class="bloc doux">Pas de connexion : la synchronisation se fera plus tard.</div>';
      }
    };

    const lancerSynchro = async bouton => {
      const texteInitial = bouton.textContent;
      bouton.disabled = true;
      bouton.textContent = 'Synchronisation…';
      const resultat = await Synchro.synchroniser();
      bouton.disabled = false;
      bouton.textContent = texteInitial;
      afficherResultatSynchro(resultat);
      if (resultat.etat === 'ok') await this.rendre();
    };

    this.brancher('[data-synchro]', 'click', async e => { await lancerSynchro(e.currentTarget); });

    this.brancher('[data-activer-synchro]', 'click', async e => {
      const bouton = e.currentTarget;
      const depot = document.getElementById('synchro-depot').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
      const jeton = document.getElementById('synchro-jeton').value.trim();
      const phrase = document.getElementById('synchro-phrase').value;
      if (!/^[^/\s]+\/[^/\s]+$/.test(depot)) { alert('Le dépôt s\'écrit sous la forme utilisateur/dépôt, par exemple samoryx/revisions-donnees.'); return; }
      if (!jeton || !phrase) { alert('Il faut le jeton et la phrase de passe.'); return; }
      Synchro.enregistrerReglages({ depot, jeton, phrase, nomAppareil: reglages.nomAppareil });
      await lancerSynchro(bouton);
    });

    this.brancher('[data-oublier-synchro]', 'click', async () => {
      if (!confirm('Oublier le dépôt, le jeton et la phrase de passe sur cet appareil ? Tes cartes ne sont pas touchées.')) return;
      Synchro.oublier();
      await this.rendre();
    });

    this.brancher('[data-exporter]', 'click', async () => {
      const nom = await Sauvegarde.exporterFichier();
      alert('Sauvegarde enregistrée : ' + nom);
      await this.rendre();
    });

    document.getElementById('fichier-sauvegarde').addEventListener('change', async e => {
      if (!e.target.files[0]) return;
      const zone = document.getElementById('resultat-fusion');
      try {
        const donnees = await Sauvegarde.lireFichier(e.target.files[0]);
        const rapport = await Sauvegarde.fusionner(donnees);
        // Cet appareil est maintenant le plus complet des deux : on propose
        // tout de suite de renvoyer le résultat, sinon l'autre reste en retard.
        zone.innerHTML = `<div class="bloc">Fusion terminée : ${rapport.revisions} révision(s) ajoutée(s),
          ${rapport.cartes} carte(s) mise(s) à jour, ${rapport.paquets} paquet(s), ${rapport.recalculees} carte(s) replanifiée(s).
          <p class="doux">Cet appareil a maintenant tout l'historique des deux. L'autre, lui, ne connaît pas encore ce qui a été fait ici : renvoie-lui ce fichier pour qu'ils soient identiques.</p>
          <button class="bouton large" id="renvoyer-fusion">Exporter pour l'autre appareil</button></div>`;
        document.getElementById('renvoyer-fusion').addEventListener('click', async () => {
          const nom = await Sauvegarde.exporterFichier();
          alert('Fichier enregistré : ' + nom + '\n\nImporte-le sur l\'autre appareil.');
        });
      } catch (erreur) {
        zone.innerHTML = `<div class="avertissement">${this.h(erreur.message)}</div>`;
      }
    });

    this.brancher('[data-enregistrer-reglages]', 'click', async () => {
      await Donnees.majReglages({
        nouvellesParJour: Number(document.getElementById('nouvelles').value),
        retentionCible: Number(document.getElementById('retention').value),
        intervalleMaxJours: Number(document.getElementById('plafond').value),
        seuilSangsue: Number(document.getElementById('sangsue').value),
        nomAppareil: document.getElementById('appareil').value.trim() || 'Appareil'
      });
      // Le nom de l'appareil sert aussi à signer les envois de synchronisation.
      if (Synchro.estConfigure()) {
        Synchro.enregistrerReglages({ nomAppareil: document.getElementById('appareil').value.trim() || 'Appareil' });
      }
      alert('Réglages enregistrés.');
      await this.rendre();
    });

    this.brancher('[data-proteger]', 'click', async () => {
      const accorde = await navigator.storage.persist();
      alert(accorde ? 'Protection accordée.' : 'Le navigateur a refusé pour le moment. Installe l\'app sur l\'écran d\'accueil et réessaie.');
      await this.rendre();
    });

    this.brancher('[data-tout-effacer]', 'click', async () => {
      if (!confirm('Effacer TOUTES les données de cet appareil ? Exporte une sauvegarde avant.')) return;
      if (!confirm('Vraiment ? C\'est définitif.')) return;
      const magasins = ['paquets', 'cartes', 'revisions', 'reglages'];
      for (const magasin of magasins) {
        const tout = await Donnees.tous(magasin);
        for (const objet of tout) await Donnees.supprimer(magasin, objet.id);
      }
      await this.aller('accueil', {}, true);
    });
  },

  // ---------- Utilitaire ----------

  // Remplace les caractères spéciaux : sans ça, un "<" dans un cours
  // casserait la page.
  h(texte) {
    return String(texte === null || texte === undefined ? '' : texte)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
};

window.addEventListener('DOMContentLoaded', function () {
  App.demarrer();
});
