/*
 * harness.c — FC's own engine, grown from the fcref oracle into the surface
 * the GAME needs.
 *
 * scripts/fcref/harness.c is the ancestor: a probe API that builds bodies the
 * way FC builds them (gen.c), pins them the way FC pins them, steps, and reads
 * poses out. That API is preserved here VERBATIM — same names, same argument
 * lists, same semantics — so every probe that drove the oracle drives this,
 * and "the game against the oracle" stays a meaningful gate while the two
 * wasms coexist.
 *
 * What is added is everything sim.js needs that a probe never did:
 *
 *   world_create_ex     parametrized world AABB — the old engine FREEZES a
 *                       body that leaves the world box (b2Body_Freeze), so the
 *                       box has to reach past the level's void line or a piece
 *                       would stop falling before the game called it gone.
 *                       Reentrant: a second call dtors the live world first.
 *   world_reset         dtor + clear harness tables, keep the wasm instance.
 *                       The solver's eval pool uses this; the game does not.
 *   add_ghost_body      a shapeless static — the world anchor loose pins and
 *                       `fixed` props bolt to.
 *   add_poly            one CCW convex polygon on its own static body (paint).
 *   set_tangent_speed   belts: staged onto the NEXT shape, like pin_next.
 *   body_* readers      velocity, mass, inertia, sleep — the win pipeline and
 *                       the sound bed read these every frame.
 *   body_apply_force    radial gravity (§5.10). Does NOT wake — a piece asleep
 *                       on a planet stays asleep, matching what the v3 call
 *                       was asked (wake=false) on the engine this replaces.
 *   body_apply_torque   lone drives (§5.5). DOES wake — a powered wheel never
 *                       sleeps, also matching the old call (wake=true).
 *   body_gravity_scale  a piece that falls up (§5.10) on a flat level.
 *   body_teleport       movers (§9). The integrator skips invMass == 0 bodies
 *                       entirely (b2Island.cpp:143,184 — measured before this
 *                       was designed), so a mover is a static TELEPORTED each
 *                       step. Its velocity is set by hand anyway, because the
 *                       contact solver reads it for friction targets — that is
 *                       the whole of how a platform carries what rests on it —
 *                       and everything the mover touches is woken, because a
 *                       sleeping crate does not re-run its contacts and would
 *                       be left hovering where its platform used to be.
 *   hit_*               the sound layer's input (§17): pairs that TOUCH this
 *                       step and did not touch last step, with the collision
 *                       impulse converted to a Δv. This engine has no events,
 *                       so it is a walk of the world's own contact list.
 *
 * Forces: b2Island clears m_force/m_torque after integration (lines 228-229),
 * so per-step application is the native semantics — but only for bodies that
 * made it into an island. A force written onto a SLEEPING body would linger
 * there and fire whole the frame it wakes, which is why body_apply_force skips
 * sleepers instead of trusting the clear.
 *
 * Built for wasm32 with no libc (the engine ships its own malloc/math/string
 * under src/wasm). The game still isolates by instantiating once per
 * Simulation. The solver may keep an instance and call world_reset /
 * world_create_ex again; those two are the only legal reuse. Box2D 2.x
 * cannot clone a world.
 */
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <box2d/b2World.h>
#include <box2d/b2Body.h>
#include <box2d/b2Shape.h>
#include <box2d/b2Joint.h>
#include <box2d/b2RevoluteJoint.h>
#include <box2d/b2Contact.h>
#include <box2d/b2CMath.h>

/* 4096 = b2_maxProxies: the broadphase cannot hold more shapes than this, so
 * a larger body table would just move where the refusal happens. The probe
 * ancestor said 256, which a 1000-stick cost rig already exceeds. */
#define MAX_BODIES 4096

static b2World *world;
static int world_inited;	/* ctor ran; dtor not yet. world pointer may still be held. */
static b2Body *bodies[MAX_BODIES];
static int body_count;

/* fcsim sets collideConnected = true on every joint (gen.c). The running game
 * contradicts it: two bolted parts pass through each other, always (checked
 * 2026-08-11, see sim.js). Exposed as a switch rather than picked, so the
 * reference run can be asked both ways. Defaults to fcsim's value so older
 * probes are unchanged. (The pin filter below already excludes every pair
 * sharing a pin, so under it this flag decides nothing — it exists for probes
 * that switch the filter off.) */
static bool collide_connected = true;
void set_collide_connected(int v) { collide_connected = v ? true : false; }

/* FC's real filter (2026-08-15). fcsim reads a `struct block` off userData to
 * find the material; nothing here has blocks, so the bits are packed into
 * userData directly. Both sides must admit each other, as Box2D asks. A shape
 * added without bits keeps "collides with everything", so the older two-body
 * probes are unaffected.
 *
 * Category and mask are 7 bits each now (they were 8): the game's categories
 * stop at bit 6 (CAT.GHOST = 64) and the index needed the room — see UD_PACK. */
#define ENV_BIT		(1 << 0)
#define SOLID_BIT	(1 << 1)
#define WATER_BIT	(1 << 2)

/* **TWO BLOCKS THAT SHARE A PIN DO NOT COLLIDE** (2026-08-16). fcsim's
 * collision_filter has two clauses, not one: the material bits AND
 * share_joint(block1, block2). Without the second, a stack of identical
 * sticks — all on one pin, all SOLID — shoves itself apart, and the machine
 * spends its fall fighting itself (TestLevel, measured).
 *
 * fcsim compares joint NODES, which it has because it builds a graph. This API
 * is pairwise, so the node is reconstructed from the ANCHOR POINT: every body
 * remembers where it has been pinned, and two bodies pinned at the same point
 * are on the same node. That is what a node IS in the design, so the two agree
 * by construction rather than by approximation.
 *
 * This mechanism is also the game's FILTER JOINT: v3 had a constraint-free
 * "these two never collide" joint for coincident-but-unbolted pairs, and here
 * that is just both bodies remembering the shared coordinate. */
#define MAX_PINS 16
#define PIN_EPS  1e-6

static double pin_x[MAX_BODIES][MAX_PINS];
static double pin_y[MAX_BODIES][MAX_PINS];
static int pin_n[MAX_BODIES];

/* **THE PINS HAVE TO EXIST BEFORE THE BODY DOES** (2026-08-16, measured).
 *
 * Box2D 2.0 asks the filter once, when the broadphase PAIR is added, and that
 * happens inside b2World_CreateBody — so recording pins in add_joint records
 * them long after every decision has been taken. On TestLevel that showed up
 * as 772 filter calls with ZERO pin rejections before the first step. There is
 * no refilter entry point in this Box2D, so the answer has to be ready when
 * the question is asked.
 *
 * `pin_next` stages the pins for the body the NEXT add_* will create. The
 * caller already builds the joint graph before it builds anything, so it has
 * them to hand; staging avoids making it predict body indices. */
static double stage_x[MAX_PINS], stage_y[MAX_PINS];
static int stage_n;

void pin_next(double x, double y)
{
	int k;

	if (stage_n >= MAX_PINS)
		return;
	for (k = 0; k < stage_n; k++) {
		double dx = stage_x[k] - x, dy = stage_y[k] - y;
		if (dx > -PIN_EPS && dx < PIN_EPS && dy > -PIN_EPS && dy < PIN_EPS)
			return;
	}
	stage_x[stage_n] = x;
	stage_y[stage_n] = y;
	stage_n++;
}

/* Hand the staged pins to the body just created, and reset for the next one. */
static void take_staged(int idx)
{
	int k;

	if (idx >= 0 && idx < MAX_BODIES) {
		pin_n[idx] = stage_n;
		for (k = 0; k < stage_n; k++) {
			pin_x[idx][k] = stage_x[k];
			pin_y[idx][k] = stage_y[k];
		}
	}
	stage_n = 0;
}

static void remember_pin(int i, double x, double y)
{
	int k;

	if (i < 0 || i >= MAX_BODIES || pin_n[i] >= MAX_PINS)
		return;
	for (k = 0; k < pin_n[i]; k++) {
		double dx = pin_x[i][k] - x, dy = pin_y[i][k] - y;
		if (dx > -PIN_EPS && dx < PIN_EPS && dy > -PIN_EPS && dy < PIN_EPS)
			return;			/* already on this node */
	}
	pin_x[i][pin_n[i]] = x;
	pin_y[i][pin_n[i]] = y;
	pin_n[i]++;
}

static bool share_joint(int a, int b)
{
	int i, j;

	if (a < 0 || b < 0)
		return false;
	for (i = 0; i < pin_n[a]; i++) {
		for (j = 0; j < pin_n[b]; j++) {
			double dx = pin_x[a][i] - pin_x[b][j];
			double dy = pin_y[a][i] - pin_y[b][j];
			if (dx > -PIN_EPS && dx < PIN_EPS && dy > -PIN_EPS && dy < PIN_EPS)
				return true;
		}
	}
	return false;
}

/* userData packs what the filter and the hit walk need, because a shape here
 * has no `struct block` to read it off: valid bit, body index (12 bits — the
 * ancestor's 8 stopped at body 255), category, mask (7 bits each). */
#define UD_VALID	(1u << 31)
#define UD_PACK(i, c, m)	(UD_VALID | ((unsigned int)(i) << 14) \
				 | (((unsigned int)(c) & 0x7f) << 7) | ((unsigned int)(m) & 0x7f))
#define UD_IDX(u)	((int)(((u) >> 14) & 0xfff))

/* Counters, so "is the filter doing anything" is a measurement rather than a
 * guess. Cost is three increments on a path Box2D already walks. */
static int f_calls, f_untagged, f_bit_reject, f_share_reject;
int pin_count(int i)          { return (i >= 0 && i < MAX_BODIES) ? pin_n[i] : -1; }
int shares(int a, int b)      { return share_joint(a, b) ? 1 : 0; }
int filter_calls(void)        { return f_calls; }
int filter_untagged(void)     { return f_untagged; }
int filter_bit_rejects(void)  { return f_bit_reject; }
int filter_share_rejects(void){ return f_share_reject; }

static bool collision_filter(b2Shape *s1, b2Shape *s2)
{
	unsigned int a = (unsigned int)(unsigned long)s1->m_userData;
	unsigned int b = (unsigned int)(unsigned long)s2->m_userData;
	unsigned int ca, ma, cb, mb;
	int ia, ib;

	f_calls++;
	if (!(a & UD_VALID) || !(b & UD_VALID)) {
		f_untagged++;
		return true;
	}
	ia = UD_IDX(a); ib = UD_IDX(b);
	ca = (a >> 7) & 0x7f; ma = a & 0x7f;
	cb = (b >> 7) & 0x7f; mb = b & 0x7f;
	if (!((ca & mb) && (cb & ma))) {
		f_bit_reject++;
		return false;
	}
	if (share_joint(ia, ib)) {
		f_share_reject++;
		return false;
	}
	return true;
}

/* Per-body gravity scale (§5.10, a piece that falls up). 1 everywhere until
 * written; applied as a per-step force in world_step because the island
 * integrates one global gravity and this engine has no per-body dial. */
static double gscale[MAX_BODIES];

/* Belts: staged for the NEXT shape the way pins are staged for the next body,
 * so add_box keeps its argument list and every old probe compiles against the
 * same call it always made. Cleared by every add_*. */
static double stage_tangent;
void set_tangent_speed(double v) { stage_tangent = v; }

static void world_create_aabb(double gravity_y, double minx, double miny,
			      double maxx, double maxy)
{
	b2Vec2 gravity;
	b2AABB aabb;

	gravity.x = 0;
	gravity.y = gravity_y;
	aabb.minVertex.x = minx; aabb.minVertex.y = miny;
	aabb.maxVertex.x = maxx; aabb.maxVertex.y = maxy;

	if (world && world_inited) {
		b2World_dtor(world);
		world_inited = 0;
	}
	if (!world)
		world = malloc(sizeof(*world));
	b2World_ctor(world, &aabb, gravity, true);
	world_inited = 1;
	b2World_SetFilter(world, collision_filter);
	body_count = 0;
	stage_n = 0;
	stage_tangent = 0;
	f_calls = f_untagged = f_bit_reject = f_share_reject = 0;
	for (int i = 0; i < MAX_BODIES; i++) {
		pin_n[i] = 0;
		gscale[i] = 1.0;
	}
}

/* The ancestor's bounds, so older probes are byte-identical. */
void world_create(double gravity_y)
{
	world_create_aabb(gravity_y, -2000, -1450, 2000, 1450);
}

/* The game's: sized by the caller to reach past the void line, because the
 * engine FREEZES what leaves the box and a frozen piece stops falling — the
 * game must see it cross the line first. */
void world_create_ex(double gravity_y, double minx, double miny,
		     double maxx, double maxy)
{
	world_create_aabb(gravity_y, minx, miny, maxx, maxy);
}

/* A circle, exactly as gen_block builds one. `density 0` is FC's way of saying
 * static — b2Body works out its own mass from the shapes, and a zero density
 * gives a body with no mass, which Box2D 2.x treats as static. */
int add_circle(double x, double y, double r, double density, double friction,
	       double restitution, double lin_damp, double ang_damp,
	       int category, int mask)
{
	b2CircleDef circle_def;
	b2BodyDef body_def;

	b2CircleDef_ctor(&circle_def);
	b2BodyDef_ctor(&body_def);

	circle_def.radius = r;
	circle_def.m_shapeDef.density = density;
	circle_def.m_shapeDef.friction = friction;
	circle_def.m_shapeDef.restitution = restitution;
	circle_def.m_shapeDef.tangentSpeed = stage_tangent;
	circle_def.m_shapeDef.userData = (void *)(unsigned long)UD_PACK(body_count, category, mask);

	body_def.position.x = x;
	body_def.position.y = y;
	body_def.rotation = 0;
	body_def.linearDamping = lin_damp;
	body_def.angularDamping = ang_damp;
	b2BodyDef_AddShape(&body_def, &circle_def.m_shapeDef);

	/* staged BEFORE the body, because creating it is what asks the filter */
	take_staged(body_count);
	stage_tangent = 0;
	bodies[body_count] = b2World_CreateBody(world, &body_def);
	return body_count++;
}

int add_box(double x, double y, double hw, double hh, double angle, double density,
	    double friction, double restitution, double lin_damp, double ang_damp,
	    int category, int mask)
{
	b2BoxDef box_def;
	b2BodyDef body_def;

	b2BoxDef_ctor(&box_def);
	b2BodyDef_ctor(&body_def);

	box_def.extents.x = hw;
	box_def.extents.y = hh;
	box_def.m_shapeDef.density = density;
	box_def.m_shapeDef.friction = friction;
	box_def.m_shapeDef.restitution = restitution;
	box_def.m_shapeDef.tangentSpeed = stage_tangent;
	box_def.m_shapeDef.userData = (void *)(unsigned long)UD_PACK(body_count, category, mask);

	body_def.position.x = x;
	body_def.position.y = y;
	body_def.rotation = angle;
	body_def.linearDamping = lin_damp;
	body_def.angularDamping = ang_damp;
	b2BodyDef_AddShape(&body_def, &box_def.m_shapeDef);

	/* staged BEFORE the body, because creating it is what asks the filter */
	take_staged(body_count);
	stage_tangent = 0;
	bodies[body_count] = b2World_CreateBody(world, &body_def);
	return body_count++;
}

/* One CCW CONVEX polygon on its own body (paint decomposes JS-side; concavity
 * never reaches here). Vertices are staged like pins — body-local, up to
 * b2_maxPolyVertices — because eleven scalar arguments was already the ceiling
 * of readable. */
static double pv_x[b2_maxPolyVertices], pv_y[b2_maxPolyVertices];
static int pv_n;

void poly_vert(double x, double y)
{
	if (pv_n >= b2_maxPolyVertices)
		return;
	pv_x[pv_n] = x;
	pv_y[pv_n] = y;
	pv_n++;
}

int add_poly(double x, double y, double angle, double density, double friction,
	     double restitution, double lin_damp, double ang_damp,
	     int category, int mask)
{
	b2PolyDef poly_def;
	b2BodyDef body_def;
	int k;

	b2PolyDef_ctor(&poly_def);
	b2BodyDef_ctor(&body_def);

	for (k = 0; k < pv_n; k++) {
		poly_def.vertices[k].x = pv_x[k];
		poly_def.vertices[k].y = pv_y[k];
	}
	poly_def.vertexCount = pv_n;
	pv_n = 0;
	poly_def.m_shapeDef.density = density;
	poly_def.m_shapeDef.friction = friction;
	poly_def.m_shapeDef.restitution = restitution;
	poly_def.m_shapeDef.tangentSpeed = stage_tangent;
	poly_def.m_shapeDef.userData = (void *)(unsigned long)UD_PACK(body_count, category, mask);

	body_def.position.x = x;
	body_def.position.y = y;
	body_def.rotation = angle;
	body_def.linearDamping = lin_damp;
	body_def.angularDamping = ang_damp;
	b2BodyDef_AddShape(&body_def, &poly_def.m_shapeDef);

	take_staged(body_count);
	stage_tangent = 0;
	bodies[body_count] = b2World_CreateBody(world, &body_def);
	return body_count++;
}

/* A body with no shapes at all: nothing to collide, nothing to draw, mass 0 —
 * a coordinate frame to hinge on. The world anchor every loose pin and `fixed`
 * prop bolts to. Pins staged for it are taken like any body's, because two
 * pieces sharing a LOOSE pin must stop colliding exactly as if the pin were on
 * a wall. */
int add_ghost_body(double x, double y)
{
	b2BodyDef body_def;

	b2BodyDef_ctor(&body_def);
	body_def.position.x = x;
	body_def.position.y = y;
	take_staged(body_count);
	bodies[body_count] = b2World_CreateBody(world, &body_def);
	return body_count++;
}

/* A revolute joint at a point, with FC's own motor torque (gen.c: 50000000,
 * chosen to mean "never stalls"). `spin` of 0 leaves the motor off. */
void add_joint(int a, int b, double x, double y, double spin, double motor_torque)
{
	b2RevoluteJointDef joint_def;

	/* Both ends join the node at (x, y) — this is what makes them stop
	 * colliding, and it is separate from the constraint below. */
	remember_pin(a, x, y);
	remember_pin(b, x, y);

	b2RevoluteJointDef_ctor(&joint_def);
	joint_def.m_jointDef.body1 = bodies[a];
	joint_def.m_jointDef.body2 = bodies[b];
	joint_def.anchorPoint.x = x;
	joint_def.anchorPoint.y = y;
	joint_def.m_jointDef.collideConnected = collide_connected;
	if (spin != 0) {
		joint_def.motorTorque = motor_torque;
		joint_def.motorSpeed = spin;
		joint_def.enableMotor = true;
	}
	b2World_CreateJoint(world, &joint_def.m_jointDef);
}

/* ---- hits, for the sound layer (§17) ----
 *
 * This engine reports nothing, so impacts are found by differencing: a pair
 * of bodies whose contact carries a manifold THIS step and carried none last
 * step collided this step. The set is body-index pairs in an open-addressed
 * table, two generations swapped per step — contacts themselves persist while
 * AABBs overlap, so neither the contact pointer nor its mere existence marks
 * an impact; only the manifold appearing does.
 *
 * Violence is the step's accumulated normal impulse × the pair's combined
 * inverse mass — a Δv in units/s, the nearest native quantity to the approach
 * speed the mixer was tuned against. The mapping is calibrated where the
 * threshold lives, in JS, not here.
 */
#define TOUCH_SLOTS 16384	/* power of two; ~2 slots per live pair at worst */
#define MAX_HITS 64

/* The set is cleared between steps by UNDOING the slots that were written —
 * a few dozen stores — rather than wiping 64 KB of table that a machine with
 * twenty contacts barely touched. That memset was measured at ~5% of the whole
 * step. `used` records the slots; if a step ever writes more pairs than the
 * list can hold, the flag falls back to the wipe, so the set behaves the same
 * either way. */
#define TOUCH_USED 2048
typedef struct {
	unsigned int tab[TOUCH_SLOTS];
	unsigned int used[TOUCH_USED];
	int n;
	int overflow;
} touchset;
static touchset touch_a, touch_b;
static touchset *touch_prev = &touch_a, *touch_now = &touch_b;
static int hitn;
/* The sound bed is the only reader (§17). A headless run — the solver,
 * the sweep, a gate — never drains it, so it can be switched off; the
 * scan reads the world and writes nothing back to it, so switching it
 * off cannot move a body. */
static int hits_on = 1;
void set_hits(int on) { hits_on = on; }
static double hx[MAX_HITS], hy[MAX_HITS], hdv[MAX_HITS];
static int ha[MAX_HITS], hb[MAX_HITS];

static unsigned int pair_key(int i, int j)
{
	int lo = i < j ? i : j, hi = i < j ? j : i;
	/* +1 keeps body 0 out of the empty-slot value */
	return ((unsigned int)(lo + 1) << 16) | (unsigned int)(hi + 1);
}

static bool set_has(touchset *set, unsigned int key)
{
	unsigned int s = (key * 2654435761u) & (TOUCH_SLOTS - 1);
	while (set->tab[s]) {
		if (set->tab[s] == key)
			return true;
		s = (s + 1) & (TOUCH_SLOTS - 1);
	}
	return false;
}

static void set_add(touchset *set, unsigned int key)
{
	unsigned int s = (key * 2654435761u) & (TOUCH_SLOTS - 1);
	int guard = TOUCH_SLOTS;
	while (set->tab[s] && --guard) {
		if (set->tab[s] == key)
			return;
		s = (s + 1) & (TOUCH_SLOTS - 1);
	}
	if (guard) {
		set->tab[s] = key;
		if (set->n < TOUCH_USED)
			set->used[set->n++] = s;
		else
			set->overflow = 1;
	}
}

static void set_clear(touchset *set)
{
	int i;

	if (set->overflow) {
		memset(set->tab, 0, sizeof(set->tab));
		set->overflow = 0;
	} else {
		for (i = 0; i < set->n; i++)
			set->tab[set->used[i]] = 0;
	}
	set->n = 0;
}

int hit_count(void)     { return hitn; }
double hit_x(int k)     { return (k >= 0 && k < hitn) ? hx[k] : 0; }
double hit_y(int k)     { return (k >= 0 && k < hitn) ? hy[k] : 0; }
double hit_dv(int k)    { return (k >= 0 && k < hitn) ? hdv[k] : 0; }
int hit_a(int k)        { return (k >= 0 && k < hitn) ? ha[k] : -1; }
int hit_b(int k)        { return (k >= 0 && k < hitn) ? hb[k] : -1; }

static int fc_index_of_ptr(void *p);

static void collect_hits(void)
{
	b2Contact *c;
	touchset *tmp;

	set_clear(touch_now);
	hitn = 0;
	for (c = world->m_contactList; c; c = c->m_next) {
		unsigned int ua, ub, key;
		int ia, ib;

		if (c->m_manifoldCount <= 0)
			continue;
		ua = (unsigned int)(unsigned long)c->m_shape1->m_userData;
		ub = (unsigned int)(unsigned long)c->m_shape2->m_userData;
		if (!(ua & UD_VALID) || !(ub & UD_VALID)) {
			/* an FC-built world's shapes carry `struct block *`
			 * instead of packed bits — map through the registry so
			 * imported levels still make noise */
			ia = fc_index_of_ptr(c->m_shape1->m_userData);
			ib = fc_index_of_ptr(c->m_shape2->m_userData);
			if (ia < 0 || ib < 0)
				continue;	/* a bare probe shape — no report */
		} else {
			ia = UD_IDX(ua); ib = UD_IDX(ub);
		}
		key = pair_key(ia, ib);
		set_add(touch_now, key);
		if (set_has(touch_prev, key))
			continue;	/* still touching, not a new impact */
		if (hitn < MAX_HITS) {
			b2Manifold *m = c->GetManifolds(c);
			double j_sum = 0;
			int mi, pi;

			for (mi = 0; mi < c->m_manifoldCount; mi++)
				for (pi = 0; pi < m[mi].pointCount; pi++)
					j_sum += m[mi].points[pi].normalImpulse;
			hx[hitn] = m[0].points[0].position.x;
			hy[hitn] = m[0].points[0].position.y;
			hdv[hitn] = j_sum * (c->m_shape1->m_body->m_invMass
					     + c->m_shape2->m_body->m_invMass);
			ha[hitn] = ia;
			hb[hitn] = ib;
			hitn++;
		}
	}
	tmp = touch_prev; touch_prev = touch_now; touch_now = tmp;
}

/* FC's step: 1/30 s, 10 iterations (gen.c). Both are arguments so a comparison
 * can ask what a different rate would have done in FC's own solver.
 *
 * The gravity-scale pass runs first, the hit walk last. Sleeping bodies are
 * skipped in the pass for the reason the header gives: the island only clears
 * the forces of bodies it integrated.
 *
 * **JOINTS TEAR, and that is FC** (2026-08-17, found on an imported walker
 * that ran 5% hot and missed its win). fcsim's own step() is not bare
 * b2World_Step: after it, any joint whose two anchors have come apart by
 * more than 50 units of MANHATTAN distance is DESTROYED (gen.c, identical
 * in both fcsim generations). Machines breaking under their own violence is
 * half of why FC contraptions read as alive, and the harness had silently
 * never done it. */
void world_step(double dt, int iterations)
{
	int i;
	b2Joint *j;

	for (i = 0; i < body_count; i++) {
		b2Body *b = bodies[i];
		if (gscale[i] == 1.0 || b->m_invMass == 0.0)
			continue;
		if (b2Body_IsSleeping(b) || b2Body_IsFrozen(b))
			continue;
		b->m_force.x += (gscale[i] - 1.0) * b->m_mass * world->m_gravity.x;
		b->m_force.y += (gscale[i] - 1.0) * b->m_mass * world->m_gravity.y;
	}
	b2World_Step(world, dt, iterations);
	j = world->m_jointList;
	while (j) {
		b2Joint *next = j->m_next;
		b2Vec2 a1 = j->GetAnchor1(j);
		b2Vec2 a2 = j->GetAnchor2(j);
		double dx = a1.x - a2.x, dy = a1.y - a2.y;
		if (dx < 0) dx = -dx;
		if (dy < 0) dy = -dy;
		if (dx + dy > 50.0)
			b2World_DestroyJoint(world, j);
		j = next;
	}
	if (hits_on)
		collect_hits();
}

double body_x(int i)     { return b2Body_GetOriginPosition(bodies[i]).x; }
double body_y(int i)     { return b2Body_GetOriginPosition(bodies[i]).y; }
double body_angle(int i) { return bodies[i]->m_rotation; }
double body_vx(int i)    { return bodies[i]->m_linearVelocity.x; }
double body_vy(int i)    { return bodies[i]->m_linearVelocity.y; }
double body_w(int i)     { return bodies[i]->m_angularVelocity; }
double body_mass(int i)  { return bodies[i]->m_mass; }
double body_inertia(int i) { return bodies[i]->m_I; }
int body_sleeping(int i) { return b2Body_IsSleeping(bodies[i]) ? 1 : 0; }
void body_wake(int i)    { b2Body_WakeUp(bodies[i]); }

void body_set_vel(int i, double vx, double vy, double w)
{
	b2Body *b = bodies[i];

	b->m_linearVelocity.x = vx;
	b->m_linearVelocity.y = vy;
	b->m_angularVelocity = w;
	b2Body_WakeUp(b);
}

/* Radial gravity. NO wake: the caller pushes every dynamic body every step,
 * and waking would mean nothing on a planet ever sleeps. A sleeping body is
 * skipped outright — see the header. */
void body_apply_force(int i, double fx, double fy)
{
	b2Body *b = bodies[i];

	if (b2Body_IsSleeping(b))
		return;
	b->m_force.x += fx;
	b->m_force.y += fy;
}

/* Lone drives. Wakes, as the old engine's call was asked to: a powered wheel
 * is never at rest. */
void body_apply_torque(int i, double t)
{
	b2Body *b = bodies[i];

	b->m_torque += t;
	b2Body_WakeUp(b);
}

void body_gravity_scale(int i, double s)
{
	if (i >= 0 && i < MAX_BODIES)
		gscale[i] = s;
}

/* Movers (§9). The pose is written directly — origin form, like add_box takes
 * it — the velocity is written for the contact solver to carry riders with,
 * and everything touched is woken so it re-runs those contacts. m_position is
 * the CENTRE OF MASS, so the origin goes through m_center; a mover is a static
 * whose m_center is (0,0), but the arithmetic is kept honest anyway. */
void body_teleport(int i, double x, double y, double angle,
		   double vx, double vy, double w)
{
	b2Body *b = bodies[i];
	b2ContactNode *cn;

	b->m_position0 = b->m_position;
	b->m_rotation0 = b->m_rotation;
	b->m_rotation = angle;
	b2Body_SyncR(b);
	b->m_position.x = x + b->m_R.col1.x * b->m_center.x + b->m_R.col2.x * b->m_center.y;
	b->m_position.y = y + b->m_R.col1.y * b->m_center.x + b->m_R.col2.y * b->m_center.y;
	b->m_linearVelocity.x = vx;
	b->m_linearVelocity.y = vy;
	b->m_angularVelocity = w;
	b2Body_SynchronizeShapes(b);
	for (cn = b->m_contactList; cn; cn = cn->next)
		b2Body_WakeUp(cn->other);
}

/* Non-sleeping dynamic bodies — the "is anything happening" gate. */
int awake_count(void)
{
	int i, n = 0;

	for (i = 0; i < body_count; i++) {
		b2Body *b = bodies[i];
		if (b->m_invMass == 0.0)
			continue;
		if (!b2Body_IsSleeping(b) && !b2Body_IsFrozen(b))
			n++;
	}
	return n;
}

/* ==== THE FC LOADER (2026-08-17) ====================================
 *
 * An imported FC design's world is built by fcsim's OWN code — xml.c,
 * graph.c, gen.c, vendored from the C++ fcsim that runs ft.jtai.dev — so a
 * fetched design replays bit-exactly by construction. The JS graph port in
 * sim.js got the joint semantics right and still lost winnable machines to
 * last-ulp differences (fp_strtod against Number on 18-digit decimals, a
 * re-quantized 21.65, one multiplication order) that a degenerate stack
 * impact amplifies twelve orders of magnitude in a single step. The only
 * arithmetic that always agrees with fcsim's is fcsim's.
 *
 * Two doors in:
 *   fc_load_xml(len)   the raw retrieveLevel.php XML, staged in fc_xml_buf —
 *                      parse INCLUDED, so even the number strings go through
 *                      fcsim's fp_strtod;
 *   fc_add_block/...   a flat block list for sources that arrive as parsed
 *                      numbers (the FC20 word-dialect pastes). Same graph,
 *                      same gen; only the string parse stays JS-side, and a
 *                      17-digit round-trip is exact anyway.
 *
 * Both end in gen_world on OUR `world` slot, so world_step (with its
 * tearing pass — gen.c's own step() rule) and every body_* reader work
 * unchanged. Blocks register into bodies[] in level-then-design order, and
 * a ptr table maps a contact's `struct block *` userData back to an index
 * so the hit walk keeps feeding the sound layer. */
#include <fcsim/xml.h>
#include <fcsim/graph.h>
#include <fcsim/gen.h>
#include <fpmath/fpmath.h>

b2World *gen_world(struct design *design);

/* the checksum is telemetry, and nothing that builds worlds reads it */
void recalculate_design_checksum(struct design *design) { (void)design; }

static char fcxml[1 << 20];
static struct xml_level fcx;
static struct design fcdes;
static struct block *fc_block_of[MAX_BODIES];
static int fc_level_n, fc_design_n, fc_active;

char *fc_xml_buf(void) { return fcxml; }
int fc_xml_cap(void)   { return sizeof(fcxml); }

/* the shared tail: graph → world → registry */
static int fc_gen(void)
{
	struct block *b;

	convert_xml(&fcx, &fcdes);
	if (world && world_inited) {
		b2World_dtor(world);
		world_inited = 0;
	}
	if (world) {
		free(world);
		world = NULL;
	}
	world = gen_world(&fcdes);
	world_inited = 1;
	body_count = 0;
	fc_level_n = fc_design_n = 0;
	stage_n = 0;
	hitn = 0;
	memset(&touch_a, 0, sizeof(touch_a));
	memset(&touch_b, 0, sizeof(touch_b));
	for (int i = 0; i < MAX_BODIES; i++) {
		pin_n[i] = 0;
		gscale[i] = 1.0;
		fc_block_of[i] = 0;
	}
	for (b = fcdes.level_blocks.head; b && body_count < MAX_BODIES; b = b->next) {
		fc_block_of[body_count] = b;
		bodies[body_count++] = b->body;
		fc_level_n++;
	}
	for (b = fcdes.design_blocks.head; b && body_count < MAX_BODIES; b = b->next) {
		fc_block_of[body_count] = b;
		bodies[body_count++] = b->body;
		fc_design_n++;
	}
	fc_active = 1;
	return fc_design_n;
}

/* door one: the XML itself, fcsim's parse included */
int fc_load_xml(int len)
{
	if (xml_parse(fcxml, len, &fcx))
		return -1;
	return fc_gen();
}

/* door two: a flat block list (type is xml.h's own enum) */
static struct xml_block *fc_tail_level, *fc_tail_player;

void fc_begin(void)
{
	fcx.level_blocks = 0;
	fcx.player_blocks = 0;
	fcx.level_id = 0;
	fc_tail_level = fc_tail_player = 0;
}

void fc_zones(double bx, double by, double bw, double bh,
	      double gx, double gy, double gw, double gh)
{
	fcx.start.position.x = bx; fcx.start.position.y = by;
	fcx.start.width = bw; fcx.start.height = bh;
	fcx.end.position.x = gx; fcx.end.position.y = gy;
	fcx.end.width = gw; fcx.end.height = gh;
}

void fc_add_block(int pool, int type, int id, double x, double y, double w,
		  double h, double rot, int goal, int j1, int j2)
{
	struct xml_block *blk = calloc(1, sizeof(*blk));
	struct xml_joint *joint;

	blk->type = type;
	blk->id = id;
	blk->position.x = x;
	blk->position.y = y;
	blk->width = w;
	blk->height = h;
	blk->rotation = rot;
	blk->goal_block = goal ? true : false;
	if (j2 >= 0) {
		joint = calloc(1, sizeof(*joint));
		joint->id = j2;
		blk->joints = joint;
	}
	if (j1 >= 0) {
		joint = calloc(1, sizeof(*joint));
		joint->id = j1;
		joint->next = blk->joints;
		blk->joints = joint;
	}
	/* the POOL is the caller's statement, exactly as the XML's two lists
	 * are — a dynamic circle can be level scenery or a player's cargo, and
	 * the type alone cannot say which */
	if (pool == 0) {
		if (fc_tail_level) fc_tail_level->next = blk; else fcx.level_blocks = blk;
		fc_tail_level = blk;
	} else {
		if (fc_tail_player) fc_tail_player->next = blk; else fcx.player_blocks = blk;
		fc_tail_player = blk;
	}
}

int fc_load_list(void) { return fc_gen(); }

/* diagnosis doors: the two halves of fc_gen, separately callable */
void fc_diag_convert(void) { convert_xml(&fcx, &fcdes); }
void fc_diag_world(void)   { world = gen_world(&fcdes); }

/* Parse ONE number with fcsim's own strtod — the paste's exact digit string,
 * staged in fc_xml_buf, read the way fcsim would read it. JS Number() is
 * correctly rounded and fp_strtod is its own thing; on 18-digit decimals the
 * two differ in the last bit, and the last bit is a fork in a degenerate
 * impact. Every number a list-fed world is built from comes through here. */
double fc_strtod(int len)
{
	double res = 0;

	fp_strtod(fcxml, len, &res);
	return res;
}

static int fc_index_of_ptr(void *p)
{
	int i;

	if (!fc_active || !p)
		return -1;
	for (i = 0; i < body_count; i++)
		if ((void *)fc_block_of[i] == p)
			return i;
	return -1;
}

int fc_level_count(void)  { return fc_level_n; }
int fc_design_count(void) { return fc_design_n; }
int fc_joint_count(void)
{
	int n = 0;

	for (b2Joint *j = world ? world->m_jointList : 0; j; j = j->m_next)
		n++;
	return n;
}
/* The design's NODES - fcsim's own joint list, one entry per distinct
 * connection point - as the complexity a b2 joint count cannot give: a stack
 * of N rods on one point is N-1 b2 joints and ONE node. fc_node_count is
 * every node (a rod's free end included, and a wheel's hub and spokes);
 * fc_joined_count is the nodes with two or more blocks on them - the ones
 * where a machine is actually bolted together (2026-08-18, "order Sticks on
 * unique joints - complexity, not stack weight"). */
int fc_node_count(void)
{
	int n = 0;

	for (struct joint *j = fc_active ? fcdes.joints.head : 0; j; j = j->next)
		n++;
	return n;
}
int fc_joined_count(void)
{
	int n = 0;

	for (struct joint *j = fc_active ? fcdes.joints.head : 0; j; j = j->next) {
		int k = j->gen ? 1 : 0;
		for (struct attach_node *a = j->att.head; a && k < 2; a = a->next)
			k++;
		if (k >= 2)
			n++;
	}
	return n;
}
int fc_block_goal(int i)
{
	return (i >= 0 && i < body_count && fc_block_of[i]) ? (fc_block_of[i]->goal ? 1 : 0) : 0;
}
int fc_block_shape(int i)
{
	return (i >= 0 && i < body_count && fc_block_of[i]) ? (int)fc_block_of[i]->shape.type : -1;
}

/* FC's OWN win test, ported from arena.cpp's goal_blocks_inside_goal_area:
 * the axis-aligned bounding box of every goal block, fully inside the goal
 * area, zero slack, decided the instant it is true. */
static void fc_block_bb(struct block *block, double *cx, double *cy,
			double *hw, double *hh)
{
	struct shell shell;

	get_shell(&shell, &block->shape);
	if (block->body) {
		shell.x = block->body->m_position.x;
		shell.y = block->body->m_position.y;
		shell.angle = block->body->m_rotation;
	}
	*cx = shell.x;
	*cy = shell.y;
	if (shell.type == SHELL_CIRC) {
		*hw = shell.circ.radius;
		*hh = shell.circ.radius;
	} else {
		double wc = fp_cos(shell.angle) * shell.rect.w;
		double ws = fp_sin(shell.angle) * shell.rect.w;
		double hc = fp_cos(shell.angle) * shell.rect.h;
		double hs = fp_sin(shell.angle) * shell.rect.h;
		double aw = wc < 0 ? -wc : wc, ahs = hs < 0 ? -hs : hs;
		double aws = ws < 0 ? -ws : ws, ahc = hc < 0 ? -hc : hc;
		*hw = (aw + ahs) / 2;
		*hh = (aws + ahc) / 2;
	}
}

int fc_goal_won(void)
{
	struct block *b;
	int any = 0;
	/* the DESIGN's own goal area — convert_xml built it from the XML end
	 * zone with expand 0, exactly what block_inside_area consults */
	double zx = fcdes.goal_area.x, zy = fcdes.goal_area.y;
	double zw = fcdes.goal_area.w + fcdes.goal_area.expand;
	double zh = fcdes.goal_area.h + fcdes.goal_area.expand;

	if (!fc_active)
		return 0;
	for (b = fcdes.design_blocks.head; b; b = b->next) {
		double cx, cy, hw, hh;

		if (!b->goal)
			continue;
		any = 1;
		fc_block_bb(b, &cx, &cy, &hw, &hh);
		if (!(cx - hw >= zx - zw / 2 && cx + hw <= zx + zw / 2
		      && cy - hh >= zy - zh / 2 && cy + hh <= zy + zh / 2))
			return 0;
	}
	return any;
}

/* Solver pooling: drop the live b2World, keep the wasm instance and the
 * malloc'd world struct. The next world_create_ex / fc_gen ctors again.
 * Safe to call with nothing inited. */
void world_reset(void)
{
	int i;

	if (world && world_inited) {
		b2World_dtor(world);
		world_inited = 0;
	}
	body_count = 0;
	stage_n = 0;
	stage_tangent = 0;
	hitn = 0;
	f_calls = f_untagged = f_bit_reject = f_share_reject = 0;
	memset(&touch_a, 0, sizeof(touch_a));
	memset(&touch_b, 0, sizeof(touch_b));
	touch_prev = &touch_a;
	touch_now = &touch_b;
	for (i = 0; i < MAX_BODIES; i++) {
		bodies[i] = NULL;
		pin_n[i] = 0;
		gscale[i] = 1.0;
		fc_block_of[i] = 0;
	}
	fc_active = 0;
	fc_level_n = fc_design_n = 0;
}
