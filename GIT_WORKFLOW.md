# Flujo de Trabajo Git — Git Flow Lite para Desarrollador Único

## Estructura de Ramas

| Rama | Propósito | Vida |
|---|---|---|
| `main` | Producción. Siempre estable, siempre deployable. | Permanente |
| `dev` | Integración. Acumula features terminadas. | Permanente |
| `feature/*` | Trabajo en curso. Una a la vez. | Temporal, se borra al mergear |
| `fix/*` | Correcciones pequeñas en curso. | Temporal |
| `feat/*` | Features medianas o grandes en curso. | Temporal |

> **Regla:** NUNCA commitear directo a `main` o `dev`. Siempre vía feature branch + merge.

## Convención de Nombres

```
feature/<descripcion-corta-kebab-case>     feature/warning-placas
fix/<bug-corto-kebab-case>                 fix/parse-qr-delimiter
feat/<modulo-corto>                        feat/escaner-handheld
```

Usar `kebab-case` (minúsculas, separado por guiones).

## El Ciclo Diario

### 1) Arrancar una feature nueva

```bash
git checkout dev
git pull origin dev
git merge origin/main                # sync: dev al tanto de main
git checkout -b feature/mi-cosa
```

### 2) Trabajar y commitear con historial limpio

```bash
git add .
git commit -m "feat: descripción específica del cambio"
# Repetir las veces que necesites. Cada commit cuenta tu historial.
# Conventional Commits: feat:, fix:, chore:, refactor:, docs:
```

### 3) Cuando la feature funciona, integrar a dev

```bash
git checkout dev
git merge --no-ff feature/mi-cosa    # --no-ff conserva el merge commit
git push origin dev
git branch -d feature/mi-cosa
git push origin --delete feature/mi-cosa
```

### 4) Sync periódico de dev con main

Antes de cada feature nueva y antes de promover a main:

```bash
git checkout dev
git merge origin/main
# Si hay conflictos, resolver y commitear.
```

### 5) Cuando dev está lista para release, promover a main

```bash
git checkout main
git pull origin main
git merge --no-ff dev
git tag -a v1.x.x -m "release: descripción"
git push origin main --tags
```

## Reglas de Oro

- **Nunca** commitear directo a `main` ni a `dev`. Siempre vía feature branch + merge.
- **Una feature a la vez.** Evita integration hell.
- **`dev` se sincroniza con `main` antes de cada feature nueva.** Evita conflictos grandes.
- **Commits chicos y descriptivos.** Tu historial por rama es tu bitácora.
- **No dejar features a medias en dev.** Trabaja una, termina, mergea, sigue.

## Conventional Commits (Referencia Rápida)

| Prefijo | Uso |
|---|---|
| `feat:` | Nueva funcionalidad |
| `fix:` | Corrección de bug |
| `chore:` | Tareas sin impacto en código (deps, configs) |
| `refactor:` | Cambio interno sin cambio de comportamiento |
| `docs:` | Solo documentación |
| `style:` | Formato, punto y coma, etc. sin cambio lógico |
| `test:` | Agregar o corregir tests |
| `perf:` | Mejora de rendimiento |

## Limpieza Inicial (Ejecutar Una Vez)

Si tienes ramas redundantes como `develop` además de `dev`:

```bash
# Eliminar rama develop local
git branch -d develop

# Eliminar rama develop remota
git push origin --delete develop

# Verificar ramas remotas obsoletas
git remote prune origin
```

## Diagrama del Flujo

```
main      o------------------------M----------> (producción)
           \                        /
dev         o----M----M----M--------/---------> (integración)
               /    /    \
feature/a    o-c-c-m
feature/b              o-c-c-m
feature/c                        o-c-m

o = commit    c = commit de feature    m = merge commit (--no-ff)
```

## Alternativa: GitHub Flow (Más Simple, Sin dev)

Si el overhead de mantener `dev` se siente innecesario porque siempre terminas features antes de empezar la siguiente, colapsa a GitHub Flow:

- Solo `main` + feature branches.
- Feature nace de `main`, se mergea a `main` cuando funciona.
- Pierdes el buffer de `dev` pero el flujo es más rápido.

## Cheat Sheet

```bash
# Nueva feature
git checkout dev && git pull && git merge origin/main
git checkout -b feature/nombre

# Trabajo
git add . && git commit -m "feat: cambio"

# Integrar a dev
git checkout dev && git merge --no-ff feature/nombre
git push origin dev
git branch -d feature/nombre

# Release
git checkout main && git merge --no-ff dev
git tag -a v1.x.x && git push origin main --tags
```
